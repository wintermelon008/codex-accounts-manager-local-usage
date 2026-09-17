import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DashboardLanguage } from "../localization/languages";
import type { DashboardSharingViewModel } from "../domain/dashboard/types";
import {
  fetchWithTimeout,
  isRetriableHttpStatus,
  isRetriableNetworkError,
  retryWithBackoff
} from "../utils/network";
import { importSharedAccountsIntoBalancePool } from "../application/accounts/importIntoBalancePool";
import type { AccountsRepository } from "../storage";
import { restoreSharedTokens } from "../storage/sharedAccounts";
import type { CodexAccountRecord, SharedCodexAccountJson } from "../core/types";
import {
  decryptSharingPayload,
  deriveSharingUserId,
  encryptSharingPayload,
  generateSharingKeyMaterial,
  type SharingKeyMaterial
} from "./crypto";
import {
  SHARING_PACKAGE_SCHEMA,
  SHARING_RETURN_PACKAGE_SCHEMA,
  sharingInfoForLease,
  type SharingLease,
  type SharingPackage,
  type SharingReturnPackage,
  type SharingReturnEnvelope,
  type SharingPeer,
  type SharingPublicProfile,
  type SharingRequest,
  type SharingState,
  type SharingTransfer
} from "./types";

const SHARING_STATE_KEY = "codexAccounts.accountSharing.v1";
const SHARING_KEYS_SECRET = "codexAccounts.accountSharing.keys.v1";
const SHARING_RELAY_TOKEN_SECRET = "codexAccounts.accountSharing.relayToken.v1";
const SHARING_LOCAL_STATE_FILE = "sharing-local-state-v1.json";
const SHARING_LOCAL_STATE_VERSION = 1;
const SHARING_POLL_INTERVAL_MS = 10_000;
const SHARING_HANDSHAKE_TIMEOUT_MS = 60_000;
const MAX_PROCESSED_TRANSFERS = 512;
const MAX_SHARED_ACCOUNTS = 50;
const DEFAULT_DISPLAY_NAME = "Manager User";
const SHARING_HEALTH_FILE = "sharing-health.json";
// A private-overlay or reverse-proxy path can take several seconds to open
// while it re-establishes. Keep the deadline independent of the deployment
// type so Docker, bare metal, Windows and macOS expose the same behavior.
const SHARING_REQUEST_TIMEOUT_MS = 10_000;
const SHARING_GET_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
const SHARING_REGISTRATION_VALIDATION_TTL_MS = 5 * 60 * 1_000;
// A return is already durable in the Relay after the recipient's POST. Check
// the owner acknowledgement a few times promptly so a second button click is
// never needed just to trigger the next confirmation read. The regular
// sharing poll remains the long-lived fallback after these targeted checks.
const SHARING_RETURN_CONFIRMATION_RETRY_DELAYS_MS = [500, 1_500, 3_000, 5_000, 10_000] as const;

type SwitchAway = (accountId: string) => Promise<boolean>;

type SharingServiceOptions = {
  now?: () => number;
  relayUrl?: () => string;
  bootstrapToken?: () => string | undefined;
  switchAway?: SwitchAway;
};

type SharingLocalStateFile = {
  version: typeof SHARING_LOCAL_STATE_VERSION;
  keys: SharingKeyMaterial;
  relayToken?: string;
  state?: Partial<SharingState>;
};

export class AccountSharingService implements vscode.Disposable {
  private keys: SharingKeyMaterial | undefined;
  private state: SharingState | undefined;
  private relayToken: string | undefined;
  private relayRegistrationValidatedAt: number | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<void> | undefined;
  private accountChangeSubscription: vscode.Disposable | undefined;
  private disposed = false;
  private initialized = false;
  private lastSyncAt: number | undefined;
  private lastSyncError: string | undefined;
  private localStatePath: string | undefined;
  private readonly returnConfirmationTimers = new Map<string, NodeJS.Timeout>();
  private readonly returnConfirmationAttempts = new Map<string, number>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository,
    private readonly onChanged: () => void,
    private readonly options: SharingServiceOptions = {}
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const legacyState = this.context.globalState.get<Partial<SharingState>>(SHARING_STATE_KEY);
    const localState = await this.loadLocalState(legacyState?.profile?.displayName);
    this.keys = localState.keys;
    const userId = deriveSharingUserId(this.keys.identityPublicKey);
    const saved =
      localState.state?.profile?.identityPublicKey === this.keys.identityPublicKey
        ? localState.state
        : stateSeedWithDisplayName(localState.state?.profile?.displayName ?? legacyState?.profile?.displayName);
    this.state = normalizeState(saved, {
      userId,
      identityPublicKey: this.keys.identityPublicKey,
      encryptionPublicKey: this.keys.encryptionPublicKey
    });
    this.relayToken = localState.relayToken?.trim() || undefined;
    this.initialized = true;
    this.accountChangeSubscription = this.repo.onDidChangeAccounts((accountIds) => {
      if (!accountIds || accountIds.some((accountId) => this.isIncomingLeaseAccount(accountId))) {
        void this.poll();
      }
    });
    const recoveredExpiredAccounts = await this.recoverExpiredAccountSharing();
    await this.persistState();
    if (recoveredExpiredAccounts) {
      this.onChanged();
    }
  }

  start(): void {
    if (this.disposed || this.pollTimer) {
      return;
    }
    void this.poll();
    for (const lease of this.state?.leases ?? []) {
      if (lease.direction === "incoming" && lease.state === "return_pending") {
        this.scheduleReturnConfirmationPolling(lease.leaseId);
      }
    }
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, SHARING_POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.accountChangeSubscription?.dispose();
    this.accountChangeSubscription = undefined;
    for (const timer of this.returnConfirmationTimers.values()) {
      clearTimeout(timer);
    }
    this.returnConfirmationTimers.clear();
    this.returnConfirmationAttempts.clear();
  }

  getProfile(): SharingPublicProfile {
    this.assertInitialized();
    const state = this.state!;
    return {
      userId: state.profile.userId,
      displayName: state.profile.displayName,
      identityPublicKey: state.profile.identityPublicKey,
      encryptionPublicKey: state.profile.encryptionPublicKey
    };
  }

  getTrustedPeers(): readonly SharingPeer[] {
    this.assertInitialized();
    return this.state!.peers.filter((peer) => peer.relationship === "trusted").map((peer) => ({ ...peer }));
  }

  getPendingRequests(): readonly SharingRequest[] {
    this.assertInitialized();
    return this.state!.pendingRequests.map((request) => ({ ...request }));
  }

  getLeases(): readonly SharingLease[] {
    this.assertInitialized();
    return this.state!.leases.map((lease) => ({ ...lease, accountIds: [...lease.accountIds] }));
  }

  getDashboardView(): DashboardSharingViewModel {
    this.assertInitialized();
    return {
      userId: this.state!.profile.userId,
      displayName: this.state!.profile.displayName,
      relayConfigured: Boolean(this.getRelayUrl()),
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      peers: this.getTrustedPeers().concat(
        this.state!.peers.filter((peer) => peer.relationship === "pending_outgoing").map((peer) => ({ ...peer }))
      ),
      pendingRequests: this.getPendingRequests().map((request) => ({
        id: request.id,
        fromUserId: request.fromUserId,
        fromDisplayName: request.fromProfile?.displayName ?? request.fromUserId
      }))
    };
  }

  async poll(): Promise<void> {
    if (this.disposed || !this.initialized || this.pollInFlight) {
      return;
    }
    this.pollInFlight = this.pollInternal()
      .then(() => {
        this.lastSyncAt = this.now();
        this.lastSyncError = undefined;
        void this.persistSyncHealth();
      })
      .catch((error: unknown) => {
        this.lastSyncAt = this.now();
        const message = describeError(error);
        this.lastSyncError = message;
        void this.persistSyncHealth();
        if (!this.disposed) {
          console.warn(`[codexAccounts] account sharing sync failed: ${message}`);
          // Sync health is diagnostic state only. Do not rebuild the Dashboard
          // on every transient DERP/Relay error; the next explicit sharing
          // action or a real lease/request change will publish the view.
        }
      })
      .finally(() => {
        this.pollInFlight = undefined;
      });
    await this.pollInFlight;
  }

  async configureRelay(): Promise<void> {
    const current = this.getRelayUrl();
    const entered = await vscode.window.showInputBox({
      prompt: "输入共享 Relay URL；两台 Manager 必须使用同一个 Relay",
      value: current,
      placeHolder: "https://manager-sharing.example.com"
    });
    if (entered === undefined) {
      return;
    }
    await this.setRelayUrl(entered);
  }

  async setRelayUrl(value: string): Promise<void> {
    const normalized = normalizeRelayUrl(value);
    if (!normalized) {
      throw new Error("共享 Relay URL 无效");
    }
    await vscode.workspace
      .getConfiguration("codexAccounts")
      .update("sharingRelayUrl", normalized, vscode.ConfigurationTarget.Global);
    this.relayToken = undefined;
    this.relayRegistrationValidatedAt = undefined;
    await this.persistLocalState();
    await this.poll();
    this.onChanged();
  }

  async setPeerNote(userId: string, note: string): Promise<void> {
    this.assertInitialized();
    const peer = this.state!.peers.find((candidate) => candidate.userId === userId);
    if (!peer) {
      throw new Error("共享好友不存在");
    }
    const normalized = note.trim().slice(0, 80);
    peer.note = normalized || undefined;
    await this.persistState();
    this.onChanged();
  }

  async removePeer(userId: string): Promise<boolean> {
    this.assertInitialized();
    const peer = this.state!.peers.find((candidate) => candidate.userId === userId);
    if (!peer) {
      return false;
    }
    const activeLease = this.state!.leases.find(
      (lease) =>
        lease.peerUserId === userId &&
        lease.state !== "returned" &&
        lease.state !== "failed" &&
        lease.state !== "expired"
    );
    if (activeLease) {
      throw new Error("该好友仍有活动共享租约，请先归还账号后再删除好友");
    }
    const choice = await vscode.window.showWarningMessage(
      `删除好友 ${peer.note?.trim() || peer.displayName}？删除后双方需要重新发送并接受好友请求才能共享账号。`,
      { modal: true },
      "删除好友"
    );
    if (choice !== "删除好友") {
      return false;
    }
    await this.request(`/v1/sharing/peers/${encodeURIComponent(userId)}/remove`, { method: "POST" });
    this.state!.peers = this.state!.peers.filter((candidate) => candidate.userId !== userId);
    this.state!.pendingRequests = this.state!.pendingRequests.filter(
      (request) => request.fromUserId !== userId && request.toUserId !== userId
    );
    await this.persistState();
    this.onChanged();
    return true;
  }

  async addPeerById(userId: string): Promise<void> {
    this.assertInitialized();
    const normalized = userId.trim();
    const profile = await this.lookupUser(normalized);
    if (profile.userId === this.getProfile().userId) {
      throw new Error("不能添加自己");
    }
    const existing = this.state!.peers.find((peer) => peer.userId === profile.userId);
    if (existing?.relationship === "trusted") {
      return;
    }
    const request = await this.request<SharingRequest>("/v1/sharing/requests", {
      method: "POST",
      body: JSON.stringify({ toUserId: profile.userId })
    });
    this.state!.peers = [
      ...this.state!.peers.filter((peer) => peer.userId !== profile.userId),
      { ...profile, relationship: "pending_outgoing", addedAt: this.now(), requestId: request.id }
    ];
    await this.persistState();
    this.onChanged();
  }

  async acceptRequest(requestId: string, accepted: boolean): Promise<void> {
    this.assertInitialized();
    const request = this.state!.pendingRequests.find((candidate) => candidate.id === requestId);
    if (!request) {
      throw new Error("共享请求不存在或已处理");
    }
    await this.request(`/v1/sharing/requests/${encodeURIComponent(requestId)}/${accepted ? "accept" : "reject"}`, {
      method: "POST"
    });
    this.state!.pendingRequests = this.state!.pendingRequests.filter((candidate) => candidate.id !== requestId);
    if (accepted && request.fromProfile) {
      this.upsertTrustedPeer(request.fromProfile);
    }
    await this.persistState();
    this.onChanged();
  }

  async resetIdentity(): Promise<void> {
    this.assertInitialized();
    const activeLeases = this.state!.leases.filter(
      (lease) => lease.state !== "returned" && lease.state !== "failed" && lease.state !== "expired"
    );
    if (activeLeases.length > 0) {
      void vscode.window.showWarningMessage("当前存在活动共享租约，请先归还账号后再重新生成共享 ID。 ");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "重新生成后，本机共享 ID、好友关系和共享请求记录都会变化；账号池和账号凭据不会被删除。继续？",
      { modal: true },
      "重新生成共享 ID"
    );
    if (choice !== "重新生成共享 ID") {
      return;
    }

    const displayName = this.state!.profile.displayName;
    const keys = generateSharingKeyMaterial();
    const profile = {
      userId: deriveSharingUserId(keys.identityPublicKey),
      identityPublicKey: keys.identityPublicKey,
      encryptionPublicKey: keys.encryptionPublicKey
    };
    this.keys = keys;
    this.state = normalizeState(undefined, profile);
    this.state.profile.displayName = displayName;
    this.relayToken = undefined;
    this.relayRegistrationValidatedAt = undefined;
    await this.persistState();
    this.onChanged();
    void vscode.window.showInformationMessage(`已生成新的共享 ID：${profile.userId}`);
  }

  async shareAccountsWithPrompt(accountIds: readonly string[], language: DashboardLanguage): Promise<void> {
    this.assertInitialized();
    const peers = this.getTrustedPeers();
    if (peers.length === 0) {
      void vscode.window.showWarningMessage(
        language === "zh" || language === "zh-hant"
          ? "还没有已接受的共享对象。请先打开账号共享，使用对方用户 ID 添加并等待对方接受。"
          : "No accepted sharing peers are available. Add a user ID and wait for the peer to accept first."
      );
      return;
    }
    const selectedPeer = await vscode.window.showQuickPick(
      peers.map((peer) => ({
        label: peer.note?.trim() || peer.displayName,
        description: peer.note?.trim() ? `${peer.displayName} · ${peer.userId}` : peer.userId,
        peer
      })),
      { placeHolder: language === "zh" || language === "zh-hant" ? "选择共享对象" : "Choose a sharing peer" }
    );
    if (!selectedPeer) {
      return;
    }
    const deadline = await vscode.window.showQuickPick(
      [
        { label: "10 分钟", value: 10 * 60 * 1_000 },
        { label: "30 分钟", value: 30 * 60 * 1_000 },
        { label: "1 小时", value: 60 * 60 * 1_000 },
        { label: "6 小时", value: 6 * 60 * 60 * 1_000 },
        { label: "24 小时（默认）", value: 24 * 60 * 60 * 1_000 },
        { label: "3 天", value: 3 * 24 * 60 * 60 * 1_000 }
      ],
      { placeHolder: "设置归还期限" }
    );
    if (!deadline) {
      return;
    }
    await this.shareAccounts(accountIds, selectedPeer.peer, this.now() + deadline.value);
  }

  async shareAccountsWithPeer(
    accountIds: readonly string[],
    peerUserId: string,
    expiresAt: number
  ): Promise<void> {
    this.assertInitialized();
    const peer = this.getTrustedPeers().find((candidate) => candidate.userId === peerUserId.trim());
    if (!peer) {
      throw new Error("共享对象尚未接受好友请求");
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("归还期限必须在当前时间之后");
    }
    await this.shareAccounts(accountIds, peer, expiresAt);
  }

  async shareAccounts(accountIds: readonly string[], peer: SharingPeer, expiresAt: number): Promise<void> {
    this.assertInitialized();
    const uniqueIds = [...new Set(accountIds)].filter(Boolean);
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_SHARED_ACCOUNTS) {
      throw new Error(`一次最多共享 ${MAX_SHARED_ACCOUNTS} 个账号`);
    }
    if (peer.relationship !== "trusted") {
      throw new Error("共享对象尚未接受好友请求");
    }
    const accounts = await this.repo.exportSharedAccounts(uniqueIds);
    if (accounts.length !== uniqueIds.length) {
      throw new Error("部分账号缺少可共享的 OAuth 凭据");
    }
    const existing = await Promise.all(uniqueIds.map((id) => this.repo.getAccount(id)));
    const alreadyShared = existing.find((account) => account?.sharing);
    if (alreadyShared) {
      throw new Error(`账号 ${alreadyShared.email} 已处于共享租约中`);
    }
    for (const account of existing) {
      if (account?.isActive) {
        const switched = await this.options.switchAway?.(account.id);
        if (!switched) {
          throw new Error(`账号 ${account.email} 当前正在使用，且没有安全的本机替代账号，暂不能共享`);
        }
      }
    }
    const previousPoolState = new Map(
      existing
        .filter((account): account is CodexAccountRecord => Boolean(account))
        .map((account) => [account.id, Boolean(account.balancePoolEnabled)])
    );
    await this.repo.removeFromBalancePool(uniqueIds);
    const leaseId = randomUUID();
    const packageValue: SharingPackage = {
      schema: SHARING_PACKAGE_SCHEMA,
      leaseId,
      expiresAt,
      accounts
    };
    let transfer: SharingTransfer;
    try {
      const envelope = encryptSharingPayload(
        packageValue,
        this.keys!,
        this.getProfile().userId,
        peer.userId,
        peer.encryptionPublicKey,
        this.now()
      );
      transfer = await this.request<SharingTransfer>("/v1/sharing/transfers", {
        method: "POST",
        body: JSON.stringify({ recipientUserId: peer.userId, expiresAt, envelope })
      });
    } catch (error) {
      for (const [accountId, enabled] of previousPoolState) {
        await this.repo.setBalancePoolMembership(accountId, enabled).catch(() => undefined);
      }
      throw error;
    }

    const lease: SharingLease = {
      leaseId,
      transferId: transfer.id,
      direction: "outgoing",
      state: "shared",
      peerUserId: peer.userId,
      peerDisplayName: peer.displayName,
      accountIds: uniqueIds,
      expiresAt,
      createdAt: this.now(),
      handshakeDeadlineAt: this.now() + SHARING_HANDSHAKE_TIMEOUT_MS,
      ownerAccountStates: existing
        .filter((account): account is CodexAccountRecord => Boolean(account))
        .map((account) => ({
          accountId: account.id,
          isHidden: Boolean(account.isHidden),
          balancePoolEnabled: Boolean(account.balancePoolEnabled)
        }))
    };
    this.state!.leases = [...this.state!.leases.filter((candidate) => candidate.leaseId !== leaseId), lease];
    for (const accountId of uniqueIds) {
      await this.repo.setAccountSharingInfo(accountId, sharingInfoForLease(lease, "shared"));
    }
    await this.repo.hideAccounts(uniqueIds);
    await this.persistState();
    this.onChanged();
    void vscode.window.showInformationMessage(
      `已将 ${uniqueIds.length} 个账号共享给 ${peer.displayName}，归还期限为 ${formatDate(expiresAt)}。`
    );
  }

  async returnLease(
    leaseId: string,
    reason: "manual" | "expired" | "quota_exhausted" = "manual",
    requestedAccountIds?: readonly string[]
  ): Promise<boolean> {
    this.assertInitialized();
    const lease = this.state!.leases.find(
      (candidate) => candidate.leaseId === leaseId && candidate.direction === "incoming"
    );
    if (!lease || lease.state === "returned") {
      return false;
    }
    const targetIds = requestedAccountIds
      ? [...new Set(requestedAccountIds)].filter((accountId) => lease.accountIds.includes(accountId))
      : [...lease.accountIds];
    if (targetIds.length === 0) {
      return false;
    }
    const accounts = await Promise.all(targetIds.map((accountId) => this.repo.getAccount(accountId)));
    for (const account of accounts) {
      if (account?.isActive) {
        const switched = await this.options.switchAway?.(account.id);
        if (!switched) {
          lease.state = "return_pending";
          lease.returnReason = reason;
          await this.markLeaseAccounts(lease, "return_pending", targetIds);
          await this.persistState();
          this.onChanged();
          return false;
        }
      }
    }
    const returningAll = targetIds.length === lease.accountIds.length;
    const peer = this.state!.peers.find(
      (candidate) => candidate.userId === lease.peerUserId && candidate.relationship === "trusted"
    );
    if (!peer) {
      throw new Error("归还账号所需的共享好友身份不可用");
    }
    const returnedAccounts = await this.repo.exportSharedAccountsForReturn(targetIds, lease.leaseId);
    if (returnedAccounts.length !== targetIds.length) {
      throw new Error("无法读取共享账号的最新凭据，归还未完成");
    }
    const returnPackage: SharingReturnPackage = {
      schema: SHARING_RETURN_PACKAGE_SCHEMA,
      leaseId: lease.leaseId,
      transferId: lease.transferId,
      accounts: returnedAccounts
    };
    const returnEnvelope = encryptSharingPayload(
      returnPackage,
      this.keys!,
      this.getProfile().userId,
      peer.userId,
      peer.encryptionPublicKey,
      this.now()
    );
    const returnPayload: SharingReturnEnvelope = {
      accountIds: targetIds,
      envelope: returnEnvelope
    };
    lease.state = "return_pending";
    lease.returnReason = reason;
    await this.markLeaseAccounts(lease, "return_pending", targetIds);
    await this.persistState();
    this.scheduleReturnConfirmationPolling(lease.leaseId);
    let transfer: SharingTransfer;
    try {
      transfer = await this.request<SharingTransfer>(
        `/v1/sharing/transfers/${encodeURIComponent(lease.transferId)}/return`,
        {
          method: "POST",
          body: JSON.stringify({ accountIds: targetIds, complete: returningAll, returnEnvelope: returnPayload })
        }
      );
    } catch (error) {
      this.onChanged();
      throw error;
    }
    await this.applyIncomingReturnConfirmation(lease, transfer.ownerConfirmedAccountIds);
    await this.persistState();
    this.onChanged();
    return true;
  }

  async returnAccount(accountId: string): Promise<boolean> {
    this.assertInitialized();
    const lease = this.state!.leases.find(
      (candidate) =>
        candidate.direction === "incoming" &&
        candidate.state !== "returned" &&
        candidate.state !== "failed" &&
        candidate.accountIds.includes(accountId)
    );
    if (!lease) {
      return false;
    }
    return this.returnLease(lease.leaseId, "manual", [accountId]);
  }

  async openManagement(language: DashboardLanguage): Promise<void> {
    this.assertInitialized();
    let close = false;
    while (!close) {
      const profile = this.getProfile();
      const choice = await vscode.window.showQuickPick(
        [
          { label: `复制我的共享 ID：${profile.userId}`, action: "copy" },
          { label: "搜索/添加用户", action: "add" },
          { label: "删除好友", action: "remove" },
          { label: `处理待接受请求（${this.state!.pendingRequests.length}）`, action: "requests" },
          { label: "重新生成本机共享 ID", action: "reset" },
          {
            label: `归还收到的账号（${this.state!.leases.filter((lease) => lease.direction === "incoming" && lease.state !== "returned").length}）`,
            action: "return"
          },
          { label: "查看共享状态", action: "status" },
          { label: "配置共享 Relay", action: "configure" },
          { label: language === "zh" || language === "zh-hant" ? "关闭" : "Close", action: "close" }
        ],
        { placeHolder: `我的共享 ID：${profile.userId}` }
      );
      if (!choice || choice.action === "close") {
        close = true;
        continue;
      }
      if (choice.action === "copy") {
        await vscode.env.clipboard.writeText(profile.userId);
        void vscode.window.showInformationMessage(`已复制共享 ID：${profile.userId}`);
      } else if (choice.action === "add") {
        await this.addPeerFromPrompt();
      } else if (choice.action === "remove") {
        await this.removePeerFromPrompt();
      } else if (choice.action === "requests") {
        await this.handleRequestPrompt();
      } else if (choice.action === "reset") {
        await this.resetIdentity();
      } else if (choice.action === "return") {
        await this.handleReturnPrompt();
      } else if (choice.action === "status") {
        this.showStatus();
      } else if (choice.action === "configure") {
        await this.configureRelay();
      }
    }
  }

  private async pollInternal(): Promise<void> {
    if (!(await this.ensureRelayRegistration())) {
      return;
    }
    // The sender cancels an unconfirmed hand-off after 60 seconds. Check the
    // transfer inbox before the less urgent peer-request and sent-transfer
    // scans so a transient DERP stall cannot consume the whole handshake
    // window before the recipient sees the envelope.
    await this.pollIncomingTransfers();
    await this.pollReturnConfirmations();
    await this.pollRequests();
    await this.pollSentTransfers();
    await this.pollLeaseConditions();
  }

  /**
   * A lease can outlive the local extension state (for example after a
   * Remote-SSH profile was recreated). Once its explicit expiry has passed,
   * keeping the account marked as shared is strictly worse: it leaves the
   * account inaccessible locally while the remote side is no longer entitled
   * to use it. Reconcile this metadata without touching OAuth credentials.
   */
  private async recoverExpiredAccountSharing(): Promise<boolean> {
    const accounts = await this.repo.listAccounts();
    const expired = accounts.filter((account) => account.sharing && account.sharing.expiresAt <= this.now());
    if (expired.length === 0) {
      return false;
    }

    let changed = false;
    for (const account of expired) {
      const sharing = account.sharing;
      if (!sharing) {
        continue;
      }
      const lease = this.state!.leases.find((candidate) => candidate.leaseId === sharing.leaseId);
      if (sharing.direction === "incoming") {
        try {
          await this.repo.removeAccount(account.id);
        } catch {
          continue;
        }
      } else {
        await this.repo.setAccountSharingInfo(account.id, undefined);
        if (lease) {
          await this.restoreOwnerAccountState(lease, account.id);
        } else {
          // The pre-share pool state is unavailable after a state migration;
          // restore visibility but leave pool membership disabled for safety.
          await this.repo.unhideAccounts([account.id]).catch(() => undefined);
          await this.repo.removeFromBalancePool([account.id]).catch(() => undefined);
        }
      }

      if (lease) {
        lease.accountIds = lease.accountIds.filter((accountId) => accountId !== account.id);
        lease.state = "expired";
        lease.returnedAt = this.now();
        lease.returnReason = "expired";
      }
      changed = true;
    }
    return changed;
  }

  private async pollRequests(): Promise<boolean> {
    let changed = false;
    const incoming = await this.request<{ requests: SharingRequest[] }>("/v1/sharing/requests/inbox");
    for (const request of incoming.requests ?? []) {
      if (this.state!.pendingRequests.some((candidate) => candidate.id === request.id)) {
        continue;
      }
      const fromProfile = await this.lookupUser(request.fromUserId).catch(() => undefined);
      this.state!.pendingRequests.push({ ...request, fromProfile });
      changed = true;
    }
    const mine = await this.request<{ requests: SharingRequest[] }>("/v1/sharing/requests/mine");
    for (const request of mine.requests ?? []) {
      const peerUserId = request.fromUserId === this.getProfile().userId ? request.toUserId : request.fromUserId;
      if (request.state === "accepted") {
        if (this.state!.peers.some((peer) => peer.userId === peerUserId && peer.relationship === "trusted")) {
          continue;
        }
        const profile = await this.lookupUser(peerUserId).catch(() => undefined);
        if (profile) {
          const previous = this.state!.peers.find((peer) => peer.userId === peerUserId);
          this.upsertTrustedPeer(profile);
          if (
            !previous ||
            previous.relationship !== "trusted" ||
            previous.identityPublicKey !== profile.identityPublicKey ||
            previous.encryptionPublicKey !== profile.encryptionPublicKey
          ) {
            changed = true;
          }
        }
      } else if (request.state === "rejected" || request.state === "revoked") {
        const hadPeer = this.state!.peers.some((peer) => peer.userId === peerUserId);
        this.state!.peers = this.state!.peers.filter((peer) => peer.userId !== peerUserId);
        changed ||= hadPeer;
      }
    }
    if (changed) {
      await this.persistState();
      this.onChanged();
    }
    return changed;
  }

  private async pollIncomingTransfers(): Promise<void> {
    let changed = false;
    const response = await this.request<{ transfers: SharingTransfer[] }>("/v1/sharing/transfers/inbox");
    for (const transfer of response.transfers ?? []) {
      if (this.state!.processedTransferIds.includes(transfer.id)) {
        await this.acknowledgeTransfer(transfer.id, { status: "completed", imported: 0, poolEnabled: 0 });
        continue;
      }
      if (transfer.expiresAt <= this.now()) {
        await this.request(`/v1/sharing/transfers/${encodeURIComponent(transfer.id)}/return`, { method: "POST" }).catch(
          () => undefined
        );
        this.state!.processedTransferIds.push(transfer.id);
        changed = true;
        await this.acknowledgeTransfer(transfer.id, {
          status: "failed",
          imported: 0,
          poolEnabled: 0,
          message: "sharing lease expired"
        });
        continue;
      }
      const peer = this.state!.peers.find(
        (candidate) => candidate.userId === transfer.fromUserId && candidate.relationship === "trusted"
      );
      if (!peer) {
        this.state!.processedTransferIds.push(transfer.id);
        changed = true;
        await this.acknowledgeTransfer(transfer.id, {
          status: "failed",
          imported: 0,
          poolEnabled: 0,
          message: "sender is not an accepted sharing peer"
        });
        continue;
      }
      try {
        const packageValue = decryptSharingPayload(transfer.envelope, this.keys!, this.getProfile().userId, {
          userId: peer.userId,
          identityPublicKey: peer.identityPublicKey
        }) as SharingPackage;
        validateSharingPackage(packageValue, transfer);
        await this.assertNoAccountConflict(packageValue.accounts);
        const summary = await importSharedAccountsIntoBalancePool(this.repo, packageValue.accounts);
        const localAccountIds = summary.accounts
          .map((account) => account.accountId)
          .filter((accountId): accountId is string => Boolean(accountId));
        if (localAccountIds.length === 0) {
          throw new Error("shared package did not import any account");
        }
        const lease: SharingLease = {
          leaseId: packageValue.leaseId,
          transferId: transfer.id,
          direction: "incoming",
          state: "received",
          peerUserId: peer.userId,
          peerDisplayName: peer.displayName,
          accountIds: localAccountIds,
          expiresAt: transfer.expiresAt,
          createdAt: this.now()
        };
        this.state!.leases = [...this.state!.leases.filter((candidate) => candidate.leaseId !== lease.leaseId), lease];
        for (const accountId of localAccountIds) {
          await this.repo.setAccountSharingInfo(accountId, sharingInfoForLease(lease, "received"));
        }
        this.state!.processedTransferIds.push(transfer.id);
        changed = true;
        await this.persistState();
        const acknowledged = await this.acknowledgeTransfer(transfer.id, {
          status: summary.status,
          imported: summary.imported,
          poolEnabled: summary.poolEnabled
        });
        if (acknowledged.state === "cancelled" || acknowledged.state === "returned" || acknowledged.state === "failed") {
          await this.removeIncomingLeaseAccounts(lease, localAccountIds);
          this.state!.leases = this.state!.leases.filter((candidate) => candidate.leaseId !== lease.leaseId);
          changed = true;
          await this.persistState();
          continue;
        }
        void vscode.window.showInformationMessage(
          `已自动导入 ${summary.imported} 个共享账号，并加入无感池。归还期限为 ${formatDate(transfer.expiresAt)}。`
        );
      } catch (error) {
        this.state!.processedTransferIds.push(transfer.id);
        changed = true;
        await this.acknowledgeTransfer(transfer.id, {
          status: "failed",
          imported: 0,
          poolEnabled: 0,
          message: describeError(error)
        });
      }
    }
    this.state!.processedTransferIds = this.state!.processedTransferIds.slice(-MAX_PROCESSED_TRANSFERS);
    await this.persistState();
    if (changed) {
      this.onChanged();
    }
  }

  private async pollReturnConfirmations(): Promise<void> {
    let changed = false;
    const pending = this.state!.leases.filter(
      (lease) => lease.direction === "incoming" && lease.state === "return_pending"
    );
    for (const lease of pending) {
      try {
        const before = JSON.stringify(lease);
        const transfer = await this.request<SharingTransfer>(
          `/v1/sharing/transfers/${encodeURIComponent(lease.transferId)}`
        );
        await this.applyIncomingReturnConfirmation(lease, transfer.ownerConfirmedAccountIds);
        changed ||= before !== JSON.stringify(lease);
      } catch (error) {
        console.warn(`[codexAccounts] account return confirmation poll failed: ${describeError(error)}`);
      }
    }
    if (changed) {
      await this.persistState();
      this.onChanged();
    }
  }

  private scheduleReturnConfirmationPolling(leaseId: string): void {
    if (this.disposed || this.returnConfirmationTimers.has(leaseId)) {
      return;
    }
    const lease = this.state?.leases?.find((candidate) => candidate.leaseId === leaseId);
    if (!lease || lease.direction !== "incoming" || lease.state !== "return_pending") {
      this.clearReturnConfirmationPolling(leaseId);
      return;
    }
    const attempt = this.returnConfirmationAttempts.get(leaseId) ?? 0;
    const delayMs = SHARING_RETURN_CONFIRMATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      return;
    }
    this.returnConfirmationAttempts.set(leaseId, attempt + 1);
    const timer = setTimeout(() => {
      this.returnConfirmationTimers.delete(leaseId);
      void this.pollSingleReturnConfirmation(leaseId).catch((error: unknown) => {
        console.warn(`[codexAccounts] targeted account return confirmation failed: ${describeError(error)}`);
      });
    }, delayMs);
    this.returnConfirmationTimers.set(leaseId, timer);
  }

  private async pollSingleReturnConfirmation(leaseId: string): Promise<void> {
    const lease = this.state?.leases?.find((candidate) => candidate.leaseId === leaseId);
    if (!lease || lease.direction !== "incoming" || lease.state !== "return_pending") {
      this.clearReturnConfirmationPolling(leaseId);
      return;
    }
    try {
      const before = JSON.stringify({ state: lease.state, accountIds: lease.accountIds });
      const transfer = await this.request<SharingTransfer>(
        `/v1/sharing/transfers/${encodeURIComponent(lease.transferId)}`
      );
      await this.applyIncomingReturnConfirmation(lease, transfer.ownerConfirmedAccountIds);
      if (before !== JSON.stringify({ state: lease.state, accountIds: lease.accountIds })) {
        await this.persistState();
        this.onChanged();
      }
    } catch (error) {
      console.warn(`[codexAccounts] targeted account return confirmation failed: ${describeError(error)}`);
    }
    const current = this.state?.leases?.find((candidate) => candidate.leaseId === leaseId);
    if (current?.direction === "incoming" && current.state === "return_pending") {
      this.scheduleReturnConfirmationPolling(leaseId);
    } else {
      this.clearReturnConfirmationPolling(leaseId);
    }
  }

  private clearReturnConfirmationPolling(leaseId: string): void {
    const timer = this.returnConfirmationTimers.get(leaseId);
    if (timer) {
      clearTimeout(timer);
      this.returnConfirmationTimers.delete(leaseId);
    }
    this.returnConfirmationAttempts.delete(leaseId);
  }

  private async pollSentTransfers(): Promise<boolean> {
    let changed = false;
    const response = await this.request<{ transfers: SharingTransfer[] }>("/v1/sharing/transfers/sent");
    for (const transfer of response.transfers ?? []) {
      const lease = this.state!.leases.find((candidate) => candidate.transferId === transfer.id);
      if (lease?.direction !== "outgoing") {
        continue;
      }
      const before = JSON.stringify(lease);
      try {
        if (transfer.returnEnvelopes?.length) {
          await this.applyReturnedCredentials(lease, transfer);
        }
        if (lease.returnAckAccountIds?.length) {
          await this.confirmReturnedCredentials(lease);
        }
        if (transfer.state === "delivered") {
          lease.handshakeDeadlineAt = undefined;
        } else if (transfer.state === "returned") {
          // A terminal full return means every account in the local lease is
          // back. Credential-bearing return envelopes are applied above; old
          // clients without one retain the previous metadata-only behavior.
          if (!transfer.returnEnvelopes?.length && lease.accountIds.length > 0) {
            await this.finalizeOutgoingAccounts(lease);
          }
        } else if (transfer.state === "cancelled" || transfer.state === "failed") {
          if (!transfer.returnEnvelopes?.length) {
            await this.finalizeOutgoingAccounts(lease);
          }
          lease.state = "failed";
        }
      } catch (error) {
        console.warn(`[codexAccounts] returned credential package could not be applied: ${describeError(error)}`);
      }
      changed ||= before !== JSON.stringify(lease);
    }
    if (changed) {
      await this.persistState();
      this.onChanged();
    }
    return changed;
  }

  private async applyReturnedCredentials(lease: SharingLease, transfer: SharingTransfer): Promise<void> {
    const peer = this.state!.peers.find(
      (candidate) => candidate.userId === lease.peerUserId && candidate.relationship === "trusted"
    );
    if (!peer) {
      throw new Error("returned credential sender is no longer a trusted peer");
    }
    const knownAccountIds = new Set([
      ...lease.accountIds,
      ...(lease.ownerAccountStates?.map((entry) => entry.accountId) ?? []),
      ...(lease.returnAckAccountIds ?? [])
    ]);
    const confirmed = new Set(transfer.ownerConfirmedAccountIds ?? []);
    const appliedAccountIds = new Set<string>();
    for (const returned of transfer.returnEnvelopes ?? []) {
      const packageValue = decryptSharingPayload(
        returned.envelope,
        this.keys!,
        this.getProfile().userId,
        { userId: peer.userId, identityPublicKey: peer.identityPublicKey }
      ) as SharingReturnPackage;
      validateSharingReturnPackage(packageValue, lease.leaseId, transfer, knownAccountIds, returned.accountIds);
      for (const entry of packageValue.accounts) {
        const accountId = entry.id!.trim();
        if (confirmed.has(accountId) || lease.returnAckAccountIds?.includes(accountId)) {
          appliedAccountIds.add(accountId);
          continue;
        }
        const account = await this.repo.getAccount(accountId);
        if (!account) {
          throw new Error(`returned account ${accountId} is not held by the expected owner lease`);
        }
        if (account.sharing && account.sharing.leaseId !== lease.leaseId) {
          throw new Error(`returned account ${accountId} is held by another lease`);
        }
        await this.repo.updateTokens(accountId, restoreSharedTokens(entry));
        appliedAccountIds.add(accountId);
      }
    }
    if (appliedAccountIds.size > 0) {
      const targetIds = [...appliedAccountIds].filter((accountId) => lease.accountIds.includes(accountId));
      if (targetIds.length > 0) {
        await this.finalizeOutgoingAccounts(lease, targetIds);
      }
      lease.returnAckAccountIds = Array.from(
        new Set([...(lease.returnAckAccountIds ?? []), ...appliedAccountIds])
      );
    }
  }

  private async confirmReturnedCredentials(lease: SharingLease): Promise<void> {
    const accountIds = [...new Set(lease.returnAckAccountIds ?? [])];
    if (accountIds.length === 0) {
      return;
    }
    const response = await this.request<SharingTransfer>(
      `/v1/sharing/transfers/${encodeURIComponent(lease.transferId)}/confirm-return`,
      {
        method: "POST",
        body: JSON.stringify({ accountIds })
      }
    );
    const confirmed = new Set(response.ownerConfirmedAccountIds ?? []);
    lease.returnAckAccountIds = accountIds.filter((accountId) => !confirmed.has(accountId));
  }

  private async pollLeaseConditions(): Promise<void> {
    const outgoing = this.state!.leases.filter((lease) => lease.direction === "outgoing" && lease.state === "shared");
    for (const lease of outgoing) {
      const deadline = lease.handshakeDeadlineAt ?? lease.createdAt + SHARING_HANDSHAKE_TIMEOUT_MS;
      if (deadline <= this.now()) {
        await this.cancelUnconfirmedShare(lease).catch((error: unknown) => {
          console.warn(`[codexAccounts] account sharing handshake cancellation failed: ${describeError(error)}`);
        });
      }
    }

    const incoming = this.state!.leases.filter(
      (lease) =>
        lease.direction === "incoming" &&
        lease.state !== "returned" &&
        lease.state !== "failed" &&
        lease.state !== "return_pending"
    );
    for (const lease of incoming) {
      let reason: "expired" | "quota_exhausted" | undefined;
      if (lease.expiresAt <= this.now()) {
        reason = "expired";
      } else {
        const accounts = await Promise.all(lease.accountIds.map((accountId) => this.repo.getAccount(accountId)));
        if (accounts.some((account) => account && isSharedAccountQuotaExhausted(account))) {
          reason = "quota_exhausted";
        }
      }
      if (reason) {
        await this.returnLease(lease.leaseId, reason).catch((error: unknown) => {
          console.warn(`[codexAccounts] automatic account return failed: ${describeError(error)}`);
        });
      }
    }
  }

  private isIncomingLeaseAccount(accountId: string): boolean {
    return Boolean(
      this.state?.leases.some(
        (lease) => lease.direction === "incoming" && lease.state !== "returned" && lease.accountIds.includes(accountId)
      )
    );
  }

  private async cancelUnconfirmedShare(lease: SharingLease): Promise<void> {
    const result = await this.request<SharingTransfer>(
      `/v1/sharing/transfers/${encodeURIComponent(lease.transferId)}/cancel`,
      { method: "POST" }
    );
    if (result.state === "delivered") {
      lease.handshakeDeadlineAt = undefined;
      await this.persistState();
      return;
    }
    if (result.state !== "cancelled" && result.state !== "failed") {
      return;
    }
    await this.finalizeOutgoingAccounts(lease, undefined, "failed");
    lease.handshakeDeadlineAt = undefined;
    await this.persistState();
    this.onChanged();
    void vscode.window.showWarningMessage("共享接收端在 1 分钟内未确认，已自动取消，共享前账号状态已恢复。 ");
  }

  private async finalizeOutgoingAccounts(
    lease: SharingLease,
    returnedAccountIds?: readonly string[],
    outcome: "returned" | "failed" = "returned"
  ): Promise<void> {
    const targetIds = returnedAccountIds?.length
      ? lease.accountIds.filter((accountId) => returnedAccountIds.includes(accountId))
      : [...lease.accountIds];
    for (const accountId of targetIds) {
      const account = await this.repo.getAccount(accountId);
      if (account?.sharing?.leaseId !== lease.leaseId) {
        continue;
      }
      await this.repo.setAccountSharingInfo(accountId, undefined);
      await this.restoreOwnerAccountState(lease, accountId);
    }
    lease.accountIds = lease.accountIds.filter((accountId) => !targetIds.includes(accountId));
    if (outcome === "failed") {
      lease.state = "failed";
      lease.returnedAt = this.now();
    } else if (lease.accountIds.length === 0) {
      lease.state = "returned";
      lease.returnedAt = this.now();
    } else {
      lease.state = "shared";
    }
  }

  private async restoreOwnerAccountState(lease: SharingLease, accountId: string): Promise<void> {
    const previous = lease.ownerAccountStates?.find((candidate) => candidate.accountId === accountId);
    if (!previous) {
      return;
    }
    if (previous.isHidden) {
      await this.repo.hideAccounts([accountId]).catch(() => undefined);
      return;
    }
    await this.repo.unhideAccounts([accountId]).catch(() => undefined);
    if (!previous.balancePoolEnabled) {
      await this.repo.removeFromBalancePool([accountId]).catch(() => undefined);
    }
  }

  private async removeIncomingLeaseAccounts(lease: SharingLease, accountIds: readonly string[]): Promise<void> {
    for (const accountId of accountIds) {
      const account = await this.repo.getAccount(accountId).catch(() => undefined);
      if (account?.sharing?.leaseId === lease.leaseId) {
        await this.repo.removeAccount(accountId).catch(() => undefined);
      }
    }
  }

  private async applyIncomingReturnConfirmation(
    lease: SharingLease,
    confirmedAccountIds: readonly string[] | undefined
  ): Promise<void> {
    const confirmed = new Set(confirmedAccountIds ?? []);
    const targetIds = lease.accountIds.filter((accountId) => confirmed.has(accountId));
    if (targetIds.length === 0) {
      return;
    }
    for (const accountId of targetIds) {
      const account = await this.repo.getAccount(accountId).catch(() => undefined);
      if (account?.sharing?.leaseId === lease.leaseId) {
        await this.repo.removeAccount(accountId).catch(() => undefined);
      }
    }
    lease.accountIds = lease.accountIds.filter((accountId) => !targetIds.includes(accountId));
    if (lease.accountIds.length === 0) {
      lease.state = "returned";
      lease.returnedAt = this.now();
      this.clearReturnConfirmationPolling(lease.leaseId);
    } else {
      lease.state = "return_pending";
    }
  }

  private async acknowledgeTransfer(
    transferId: string,
    result: { status: "completed" | "partial" | "failed"; imported: number; poolEnabled: number; message?: string }
  ): Promise<SharingTransfer> {
    return this.request<SharingTransfer>(`/v1/sharing/transfers/${encodeURIComponent(transferId)}/ack`, {
      method: "POST",
      body: JSON.stringify(result)
    });
  }

  private async ensureRelayRegistration(): Promise<boolean> {
    const relayUrl = this.getRelayUrl();
    if (!relayUrl) {
      throw new Error("尚未配置共享 Relay URL");
    }
    if (this.relayToken) {
      if (
        this.relayRegistrationValidatedAt !== undefined &&
        this.now() - this.relayRegistrationValidatedAt < SHARING_REGISTRATION_VALIDATION_TTL_MS
      ) {
        return true;
      }
      try {
        const authenticated = await this.request<SharingPublicProfile>("/v1/sharing/me");
        if (authenticated.userId === this.getProfile().userId) {
          this.relayRegistrationValidatedAt = this.now();
          return true;
        }
        this.relayToken = undefined;
        this.relayRegistrationValidatedAt = undefined;
        void this.persistLocalState().catch(() => undefined);
      } catch (error) {
        if (readStatusCode(error) !== 401) {
          throw error;
        }
        this.relayToken = undefined;
        this.relayRegistrationValidatedAt = undefined;
        // Do not let local persistence delay the recovery registration. The
        // in-memory token is already invalidated; the next successful
        // registration will replace the stored value.
        void this.persistLocalState().catch(() => undefined);
      }
    }
    const bootstrapToken = this.getBootstrapToken();
    if (!bootstrapToken) {
      throw new Error("共享 Relay 注册令牌未配置");
    }
    const response = await this.request<{ mailboxToken?: unknown }>(
      "/v1/sharing/register",
      {
        method: "POST",
        body: JSON.stringify(this.getProfile())
      },
      bootstrapToken
    );
    if (typeof response?.mailboxToken !== "string" || !response.mailboxToken.trim()) {
      throw new Error("sharing relay did not return a mailbox token");
    }
    this.relayToken = response.mailboxToken.trim();
    this.relayRegistrationValidatedAt = this.now();
    await this.persistLocalState();
    return true;
  }

  private async lookupUser(userId: string): Promise<SharingPublicProfile> {
    if (!(await this.ensureRelayRegistration())) {
      throw new Error("尚未配置共享 Relay 或注册令牌");
    }
    return this.request<SharingPublicProfile>(`/v1/sharing/users/${encodeURIComponent(userId)}`);
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<T> {
    const relayUrl = this.getRelayUrl();
    if (!relayUrl) {
      throw new Error("尚未配置共享 Relay URL");
    }
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const token = tokenOverride ?? this.relayToken;
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const performRequest = async (): Promise<T> => {
      const response = await fetchWithTimeout(
        `${relayUrl}${path}`,
        { ...init, headers },
        SHARING_REQUEST_TIMEOUT_MS,
        "Sharing Relay request"
      );
      const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? body.error : `Sharing Relay returned HTTP ${response.status}`;
        if (response.status === 401 && token && token === this.relayToken) {
          this.relayToken = undefined;
          this.relayRegistrationValidatedAt = undefined;
          void this.persistLocalState().catch(() => undefined);
        }
        const error = new Error(detail);
        Object.assign(error, { statusCode: response.status });
        throw error;
      }
      return body as T;
    };

    // GET polling is safe to retry when DERP briefly loses the TCP path. Do
    // not replay POSTs: a response can be lost after the server has applied a
    // state change, and replaying an acknowledgement/return is unnecessary.
    if ((init.method ?? "GET").toUpperCase() === "GET") {
      return retryWithBackoff(performRequest, {
        delaysMs: SHARING_GET_RETRY_DELAYS_MS,
        shouldRetryError: (error) => {
          const statusCode = readStatusCode(error);
          return statusCode === undefined ? isRetriableNetworkError(error) : isRetriableHttpStatus(statusCode);
        }
      });
    }
    return performRequest();
  }

  private async loadLocalState(legacyDisplayName?: string): Promise<SharingLocalStateFile> {
    const storageDirectory = this.context.globalStorageUri.fsPath;
    this.localStatePath = path.join(storageDirectory, SHARING_LOCAL_STATE_FILE);
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });

    try {
      const parsed = JSON.parse(await readFile(this.localStatePath, "utf8")) as unknown;
      if (isSharingLocalStateFile(parsed)) {
        await this.clearLegacySecretStorage();
        return parsed;
      }
    } catch {
      // A missing or malformed local file starts a fresh per-host identity.
    }

    const generated: SharingLocalStateFile = {
      version: SHARING_LOCAL_STATE_VERSION,
      keys: generateSharingKeyMaterial(),
      state: stateSeedWithDisplayName(legacyDisplayName)
    };
    try {
      await writeFile(this.localStatePath, JSON.stringify(generated, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      const existing = JSON.parse(await readFile(this.localStatePath, "utf8")) as unknown;
      if (isSharingLocalStateFile(existing)) {
        await this.clearLegacySecretStorage();
        return existing;
      }
      await this.writeLocalStateFile(generated);
    }
    await this.clearLegacySecretStorage();
    return generated;
  }

  private async persistState(): Promise<void> {
    if (!this.state) {
      return;
    }
    await this.persistLocalState();
  }

  private async persistLocalState(): Promise<void> {
    if (!this.localStatePath || !this.keys || !this.state) {
      return;
    }
    await this.writeLocalStateFile({
      version: SHARING_LOCAL_STATE_VERSION,
      keys: this.keys,
      relayToken: this.relayToken,
      state: this.state
    });
  }

  private async writeLocalStateFile(value: SharingLocalStateFile): Promise<void> {
    if (!this.localStatePath) {
      return;
    }
    const temporaryPath = `${this.localStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.localStatePath);
    await chmod(this.localStatePath, 0o600).catch(() => undefined);
  }

  private async clearLegacySecretStorage(): Promise<void> {
    await Promise.allSettled([
      this.context.secrets.delete(SHARING_KEYS_SECRET),
      this.context.secrets.delete(SHARING_RELAY_TOKEN_SECRET)
    ]);
  }

  private async persistSyncHealth(): Promise<void> {
    await writeFile(
      `${this.context.globalStorageUri.fsPath}/${SHARING_HEALTH_FILE}`,
      JSON.stringify(
        {
          lastSyncAt: this.lastSyncAt,
          lastSyncError: this.lastSyncError
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 0o600 }
    ).catch(() => undefined);
  }

  private async assertNoAccountConflict(entries: readonly SharedCodexAccountJson[]): Promise<void> {
    const existing = await this.repo.listAccounts();
    for (const entry of entries) {
      const email = typeof entry.email === "string" ? entry.email.trim().toLowerCase() : undefined;
      const accountId = typeof entry.account_id === "string" ? entry.account_id.trim() : undefined;
      const conflict = existing.find((account) => {
        const emailMatches = email !== undefined && account.email.trim().toLowerCase() === email;
        const accountIdMatches = accountId !== undefined && account.accountId === accountId;
        return emailMatches || accountIdMatches;
      });
      if (conflict) {
        throw new Error(`接收端已存在账号 ${conflict.email}，为避免覆盖本地账号，本次共享未导入`);
      }
    }
  }

  private async markLeaseAccounts(
    lease: SharingLease,
    state: "received" | "return_pending",
    accountIds = lease.accountIds
  ): Promise<void> {
    for (const accountId of accountIds) {
      const account = await this.repo.getAccount(accountId);
      if (account?.sharing?.leaseId === lease.leaseId) {
        await this.repo.setAccountSharingInfo(accountId, sharingInfoForLease(lease, state));
        await this.repo.removeFromBalancePool([accountId]).catch(() => undefined);
      }
    }
  }

  private upsertTrustedPeer(profile: SharingPublicProfile): void {
    const existing = this.state!.peers.find((peer) => peer.userId === profile.userId);
    this.state!.peers = [
      ...this.state!.peers.filter((peer) => peer.userId !== profile.userId),
      {
        ...profile,
        relationship: "trusted",
        addedAt: existing?.addedAt ?? this.now(),
        note: existing?.note
      }
    ];
  }

  private async addPeerFromPrompt(): Promise<void> {
    const userId = await vscode.window.showInputBox({ prompt: "输入对方的共享用户 ID" });
    if (!userId?.trim()) {
      return;
    }
    const profile = await this.lookupUser(userId.trim());
    const choice = await vscode.window.showInformationMessage(
      `找到 ${profile.displayName}（${profile.userId}）。发送好友请求？`,
      { modal: true },
      "发送请求"
    );
    if (choice === "发送请求") {
      await this.addPeerById(profile.userId);
      void vscode.window.showInformationMessage("好友请求已发送；对方接受后才能共享账号。 ");
    }
  }

  private async removePeerFromPrompt(): Promise<void> {
    const peers = this.getTrustedPeers().concat(
      this.state!.peers.filter((peer) => peer.relationship === "pending_outgoing")
    );
    const selected = await vscode.window.showQuickPick(
      peers.map((peer) => ({
        label: peer.note?.trim() || peer.displayName,
        description: peer.note?.trim() ? `${peer.displayName} · ${peer.userId}` : peer.userId,
        peer
      })),
      { placeHolder: "选择要删除的好友" }
    );
    if (selected) {
      await this.removePeer(selected.peer.userId);
    }
  }

  private async handleRequestPrompt(): Promise<void> {
    const request = await vscode.window.showQuickPick(
      this.state!.pendingRequests.map((candidate) => ({
        label: candidate.fromProfile?.displayName ?? candidate.fromUserId,
        description: candidate.fromUserId,
        request: candidate
      })),
      { placeHolder: "选择要处理的共享请求" }
    );
    if (!request) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `接受 ${request.label} 的共享请求？接受后对方仍需主动选择账号共享；接受本身不会授予账号权限。`,
      { modal: true },
      "接受",
      "拒绝"
    );
    if (choice === "接受" || choice === "拒绝") {
      await this.acceptRequest(request.request.id, choice === "接受");
    }
  }

  private async handleReturnPrompt(): Promise<void> {
    const leases = this.state!.leases.filter(
      (lease) => lease.direction === "incoming" && lease.state !== "returned" && lease.state !== "failed"
    );
    const selected = await vscode.window.showQuickPick(
      leases.map((lease) => ({
        label: `${lease.peerDisplayName ?? lease.peerUserId} · ${lease.accountIds.length} 个账号`,
        description: `截止 ${formatDate(lease.expiresAt)}`,
        lease
      })),
      { placeHolder: "选择要归还的共享账号" }
    );
    if (!selected) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "归还后会从本机 Manager 删除这些共享账号，并通知 owner。",
      { modal: true },
      "确认归还"
    );
    if (choice === "确认归还") {
      await this.returnLease(selected.lease.leaseId, "manual");
    }
  }

  private showStatus(): void {
    const profile = this.getProfile();
    const peers = this.getTrustedPeers();
    const leases = this.getLeases().filter((lease) => lease.state !== "returned");
    void vscode.window.showInformationMessage(
      `共享 ID：${profile.userId}\n已接受对象：${peers.length}\n活动租约：${leases.length}${this.getRelayUrl() ? "" : "\n尚未配置 Relay"}`
    );
  }

  private getRelayUrl(): string {
    return normalizeRelayUrl(
      this.options.relayUrl?.() ?? vscode.workspace.getConfiguration("codexAccounts").get<string>("sharingRelayUrl", "")
    );
  }

  private getBootstrapToken(): string | undefined {
    return this.options.bootstrapToken?.() ?? process.env["CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN"]?.trim();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.state || !this.keys) {
      throw new Error("Account sharing service is not initialized");
    }
  }
}

function normalizeState(
  value: Partial<SharingState> | undefined,
  profile: Pick<SharingState["profile"], "userId" | "identityPublicKey" | "encryptionPublicKey">
): SharingState {
  return {
    version: 1,
    profile: {
      userId: profile.userId,
      displayName:
        typeof value?.profile?.displayName === "string" && value.profile.displayName.trim()
          ? value.profile.displayName.trim()
          : `${DEFAULT_DISPLAY_NAME} ${profile.userId.slice(-6)}`,
      identityPublicKey: profile.identityPublicKey,
      encryptionPublicKey: profile.encryptionPublicKey
    },
    peers: Array.isArray(value?.peers) ? value.peers.filter(isPeer) : [],
    pendingRequests: Array.isArray(value?.pendingRequests) ? value.pendingRequests.filter(isRequest) : [],
    leases: Array.isArray(value?.leases) ? value.leases.filter(isLease) : [],
    processedTransferIds: Array.isArray(value?.processedTransferIds)
      ? value.processedTransferIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_TRANSFERS)
      : []
  };
}

function stateSeedWithDisplayName(displayName?: string): Partial<SharingState> {
  return {
    version: 1,
    profile: {
      userId: "",
      displayName: typeof displayName === "string" ? displayName : "",
      identityPublicKey: "",
      encryptionPublicKey: ""
    },
    peers: [],
    pendingRequests: [],
    leases: [],
    processedTransferIds: []
  };
}

function isSharingLocalStateFile(value: unknown): value is SharingLocalStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SharingLocalStateFile>;
  return (
    candidate.version === SHARING_LOCAL_STATE_VERSION &&
    isSharingKeyMaterial(candidate.keys) &&
    (candidate.relayToken === undefined || typeof candidate.relayToken === "string")
  );
}

function isSharingKeyMaterial(value: unknown): value is SharingKeyMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SharingKeyMaterial>;
  return (
    typeof candidate.identityPrivateKey === "string" &&
    typeof candidate.identityPublicKey === "string" &&
    typeof candidate.encryptionPrivateKey === "string" &&
    typeof candidate.encryptionPublicKey === "string"
  );
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isPeer(value: unknown): value is SharingPeer {
  const peer = value as Partial<SharingPeer>;
  return Boolean(
    peer &&
    typeof peer.userId === "string" &&
    typeof peer.displayName === "string" &&
    typeof peer.identityPublicKey === "string" &&
    typeof peer.encryptionPublicKey === "string" &&
    (peer.relationship === "trusted" || peer.relationship === "pending_outgoing") &&
    typeof peer.addedAt === "number"
  );
}

function isRequest(value: unknown): value is SharingRequest {
  const request = value as Partial<SharingRequest>;
  return Boolean(
    request &&
    typeof request.id === "string" &&
    typeof request.fromUserId === "string" &&
    typeof request.toUserId === "string" &&
    (request.state === "pending" || request.state === "accepted" || request.state === "rejected" || request.state === "revoked") &&
    typeof request.createdAt === "number" &&
    typeof request.updatedAt === "number"
  );
}

function isLease(value: unknown): value is SharingLease {
  const lease = value as Partial<SharingLease>;
  return Boolean(
    lease &&
    typeof lease.leaseId === "string" &&
    typeof lease.transferId === "string" &&
    (lease.direction === "incoming" || lease.direction === "outgoing") &&
    ["shared", "received", "return_pending", "returned", "expired", "failed"].includes(lease.state ?? "") &&
    typeof lease.peerUserId === "string" &&
    Array.isArray(lease.accountIds) &&
    lease.accountIds.every((id) => typeof id === "string") &&
    typeof lease.expiresAt === "number" &&
    typeof lease.createdAt === "number" &&
    (lease.handshakeDeadlineAt === undefined || typeof lease.handshakeDeadlineAt === "number") &&
    (lease.ownerAccountStates === undefined ||
      (Array.isArray(lease.ownerAccountStates) &&
        lease.ownerAccountStates.every(
          (entry) =>
            entry &&
            typeof entry.accountId === "string" &&
            typeof entry.isHidden === "boolean" &&
            typeof entry.balancePoolEnabled === "boolean"
        )))
  );
}

function validateSharingPackage(value: SharingPackage, transfer: SharingTransfer): void {
  if (
    value.schema !== SHARING_PACKAGE_SCHEMA ||
    typeof value.leaseId !== "string" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt !== transfer.expiresAt ||
    !Array.isArray(value.accounts) ||
    value.accounts.length === 0 ||
    value.accounts.length > MAX_SHARED_ACCOUNTS
  ) {
    throw new Error("shared package is invalid");
  }
}

function validateSharingReturnPackage(
  value: SharingReturnPackage,
  leaseId: string,
  transfer: SharingTransfer,
  knownAccountIds: ReadonlySet<string>,
  outerAccountIds: readonly string[]
): void {
  if (
    value.schema !== SHARING_RETURN_PACKAGE_SCHEMA ||
    typeof value.leaseId !== "string" ||
    value.leaseId !== leaseId ||
    typeof value.transferId !== "string" ||
    value.transferId !== transfer.id ||
    !Array.isArray(value.accounts) ||
    value.accounts.length === 0 ||
    value.accounts.length > MAX_SHARED_ACCOUNTS
  ) {
    throw new Error("returned sharing package is invalid");
  }
  if (outerAccountIds.length > 0 && outerAccountIds.length !== value.accounts.length) {
    throw new Error("returned sharing package account set is inconsistent");
  }
  const packageIds = new Set<string>();
  for (const account of value.accounts) {
    if (typeof account.id !== "string" || !account.id.trim() || packageIds.has(account.id)) {
      throw new Error("returned sharing package account ID is invalid");
    }
    if (!knownAccountIds.has(account.id)) {
      throw new Error("returned sharing package contains an account outside the owner lease");
    }
    packageIds.add(account.id);
  }
  if (outerAccountIds.length > 0 && outerAccountIds.some((accountId) => !packageIds.has(accountId))) {
    throw new Error("returned sharing package account IDs do not match the return request");
  }
}

export function isSharedAccountQuotaExhausted(account: CodexAccountRecord): boolean {
  const quotaErrorCode = String(account.quotaError?.code ?? "").toLowerCase();
  const quotaErrorMessage = account.quotaError?.message?.toLowerCase() ?? "";
  if (
    quotaErrorCode.includes("quota") ||
    quotaErrorCode.includes("rate_limit") ||
    quotaErrorCode.includes("usage_limit") ||
    quotaErrorMessage.includes("quota") ||
    quotaErrorMessage.includes("rate limit") ||
    quotaErrorMessage.includes("usage limit")
  ) {
    return true;
  }
  const quota = account.quotaSummary;
  return Boolean(
    (quota?.hourlyWindowPresent === true &&
      typeof quota.hourlyPercentage === "number" &&
      quota.hourlyPercentage <= 0) ||
    (quota?.weeklyWindowPresent === true && typeof quota.weeklyPercentage === "number" && quota.weeklyPercentage <= 0)
  );
}

function normalizeRelayUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStatusCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}
