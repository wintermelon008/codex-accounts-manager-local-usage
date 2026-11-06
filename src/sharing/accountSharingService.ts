import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { DashboardLanguage } from "../localization/languages";
import type {
  DashboardAccountUsageSourceViewModel,
  DashboardCredentialSyncViewModel,
  DashboardSharingViewModel
} from "../domain/dashboard/types";
import { fetchWithTimeout, isRetriableHttpStatus, isRetriableNetworkError, retryWithBackoff } from "../utils/network";
import { importSharedAccountsIntoBalancePool } from "../application/accounts/importIntoBalancePool";
import {
  resolveAccountLifetimeTokenUsage,
  resolveAccountTokenUsage
} from "../application/dashboard/buildDashboardState";
import type { AccountsRepository } from "../storage";
import { getPrivateStatePaths } from "../storage";
import { readCachedAccountTokenUsage, type AccountTokenUsageSnapshot } from "../services/localUsageAnalytics";
import { previewSharedEntry, restoreSharedTokens } from "../storage/sharedAccounts";
import { ensureFreshAccountTokens } from "../auth/tokenRefreshCoordinator";
import { withRenewingSchedulerLease } from "../runtime/schedulerLease";
import type { CodexAccountCredentialSyncInfo, CodexAccountRecord, SharedCodexAccountJson } from "../core/types";
import { isSub2ApiAccount } from "../core/types";
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
  CREDENTIAL_SYNC_PACKAGE_SCHEMA,
  ACCOUNT_USAGE_PACKAGE_SCHEMA,
  sharingInfoForLease,
  type AccountUsagePackage,
  type AccountUsageReadRequest,
  type AccountUsageUpdate,
  type CredentialSyncPackage,
  type CredentialSyncPendingUpdate,
  type CredentialSyncRecord,
  type CredentialSyncRelayRecord,
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
import {
  createEmptyAccountUsageState,
  readAccountUsageState,
  type AccountUsageState,
  writeAccountUsageState
} from "./accountUsage";

const SHARING_STATE_KEY = "codexAccounts.accountSharing.v1";
const SHARING_KEYS_SECRET = "codexAccounts.accountSharing.keys.v1";
const SHARING_RELAY_TOKEN_SECRET = "codexAccounts.accountSharing.relayToken.v1";
const SHARING_ENABLED_KEY = "codexAccounts.accountSharing.enabled.v1";
const SHARING_LOCAL_STATE_VERSION = 1;
const SHARING_POLL_INTERVAL_MS = 10_000;
const SHARING_HANDSHAKE_TIMEOUT_MS = 60_000;
const MAX_PROCESSED_TRANSFERS = 512;
const MAX_SHARED_ACCOUNTS = 50;
const DEFAULT_DISPLAY_NAME = "Manager User";
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
const CREDENTIAL_SYNC_RETRY_MAX_MS = 5 * 60 * 1_000;

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
  private enabled = true;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<void> | undefined;
  private accountChangeSubscription: vscode.Disposable | undefined;
  private disposed = false;
  private initialized = false;
  private lastSyncAt: number | undefined;
  private lastSyncError: string | undefined;
  private accountUsageState: AccountUsageState = createEmptyAccountUsageState();
  private accountUsageLastError: string | undefined;
  private readonly accountUsagePublishedRevisions = new Map<string, { revision: number; publishedAt: number }>();
  private readonly accountUsagePublishInFlight = new Map<string, Promise<void>>();
  private readonly accountUsageResponseInFlight = new Map<string, Promise<void>>();
  private readonly accountUsageAckInFlight = new Map<string, Promise<void>>();
  private accountUsageStateWriteInFlight: Promise<void> = Promise.resolve();
  private credentialSyncEndpointRetryAt = 0;
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
    this.enabled = this.context.globalState.get<boolean>(SHARING_ENABLED_KEY, true) !== false;
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
    if (!this.enabled && this.state.leases.some((lease) => isActiveSharingLease(lease))) {
      // Never leave an active lease without the poll/return machinery needed
      // to complete it. Older builds had no feature toggle, so restore the
      // safe enabled state when a persisted lease is present.
      this.enabled = true;
      void this.context.globalState.update(SHARING_ENABLED_KEY, true);
    }
    this.relayToken = localState.relayToken?.trim() || undefined;
    this.accountUsageState = await readAccountUsageState(getPrivateStatePaths(this.context).root);
    this.initialized = true;
    this.accountChangeSubscription = this.repo.onDidChangeAccounts((accountIds) => {
      if (
        !accountIds ||
        accountIds.some(
          (accountId) => this.isIncomingLeaseAccount(accountId) || this.isCredentialSyncAccount(accountId)
        )
      ) {
        void this.poll();
      }
    });
    const recoveredExpiredAccounts = await this.recoverExpiredAccountSharing();
    await this.reconcileTerminalOutgoingLeases();
    await this.persistState();
    if (recoveredExpiredAccounts) {
      this.onChanged();
    }
  }

  start(): void {
    if (this.disposed || !this.enabled || this.pollTimer) {
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

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.accountChangeSubscription?.dispose();
    this.accountChangeSubscription = undefined;
    for (const timer of this.returnConfirmationTimers.values()) {
      clearTimeout(timer);
    }
    this.returnConfirmationTimers.clear();
    this.returnConfirmationAttempts.clear();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.assertInitialized();
    if (this.enabled === enabled) {
      return;
    }
    if (!enabled) {
      const hasActiveLease = this.state!.leases.some((lease) => isActiveSharingLease(lease));
      const hasCredentialSync = this.state!.credentialSyncs.length > 0;
      if (hasActiveLease || hasCredentialSync) {
        throw new Error(
          hasActiveLease
            ? hasCredentialSync
              ? "当前存在活动共享租约或续期同步，请先停止后再关闭账号共享"
              : "当前存在活动共享租约，请先归还账号后再关闭账号共享"
            : "当前存在活动续期同步，请先停止后再关闭账号共享"
        );
      }
    }
    this.enabled = enabled;
    await this.context.globalState.update(SHARING_ENABLED_KEY, enabled);
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
    this.onChanged();
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

  getCredentialSyncs(): readonly CredentialSyncRecord[] {
    this.assertInitialized();
    return this.state!.credentialSyncs.map((sync) => ({
      ...sync,
      accountIds: [...sync.accountIds],
      pendingUpdate: sync.pendingUpdate ? { ...sync.pendingUpdate } : undefined
    }));
  }

  async refreshRemoteAccountUsage(): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
    const syncs = this.state!.credentialSyncs.filter((sync) => sync.role === "primary" && sync.state === "active");
    if (syncs.length === 0) {
      throw new Error("当前没有可读取的从设备用量");
    }
    await this.ensureRelayRegistration();
    const response = await this.request<{ requests: AccountUsageReadRequest[] }>("/v1/sharing/usage-requests", {
      method: "POST",
      body: JSON.stringify({ syncIds: syncs.map((sync) => sync.syncId) })
    });
    const requests = response.requests ?? [];
    const requestById = new Map(this.accountUsageState.pendingRequests.map((request) => [request.requestId, request]));
    for (const request of requests) {
      requestById.set(request.id, {
        requestId: request.id,
        syncId: request.syncId,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt
      });
    }
    this.accountUsageState.pendingRequests = [...requestById.values()];
    this.accountUsageLastError = undefined;
    await this.persistAccountUsageState();
    this.onChanged();
    void this.poll();
  }

  getDashboardView(): DashboardSharingViewModel {
    this.assertInitialized();
    this.assertEnabled();
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
      })),
      credentialSyncs: this.state!.credentialSyncs.map(
        (sync): DashboardCredentialSyncViewModel => ({
          syncId: sync.syncId,
          role: sync.role,
          state: sync.state,
          peerUserId: sync.peerUserId,
          peerDisplayName: sync.peerDisplayName,
          accountIds: [...sync.accountIds],
          version: sync.version
        })
      ),
      usageReadAvailable:
        Boolean(this.getRelayUrl()) &&
        this.state!.credentialSyncs.some((sync) => sync.role === "primary" && sync.state === "active"),
      usageReadPending: this.accountUsageState.pendingRequests.length > 0,
      usageReadLastAt:
        this.accountUsageState.sources.reduce((latest, source) => Math.max(latest, source.receivedAt), 0) || undefined,
      usageReadError: this.accountUsageLastError,
      accountUsageSources: this.getDashboardAccountUsageSources()
    };
  }

  async poll(): Promise<void> {
    if (this.disposed || !this.initialized || !this.enabled || this.pollInFlight) {
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
    this.assertEnabled();
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
    this.assertEnabled();
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
    this.assertEnabled();
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
    this.assertEnabled();
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
    if (this.state!.credentialSyncs.some((sync) => sync.peerUserId === userId)) {
      throw new Error("该好友仍有续期同步，请先停止同步后再删除好友");
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
    this.accountUsageState.sources = this.accountUsageState.sources.filter((source) => source.sourceUserId !== userId);
    this.accountUsageState.pendingRequests = this.accountUsageState.pendingRequests.filter(
      (request) =>
        !this.state!.credentialSyncs.some((sync) => sync.syncId === request.syncId && sync.peerUserId === userId)
    );
    await this.persistState();
    await this.persistAccountUsageState();
    this.onChanged();
    return true;
  }

  async addPeerById(userId: string): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
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
    this.assertEnabled();
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
    this.assertEnabled();
    const activeLeases = this.state!.leases.filter(
      (lease) => lease.state !== "returned" && lease.state !== "failed" && lease.state !== "expired"
    );
    if (activeLeases.length > 0 || this.state!.credentialSyncs.length > 0) {
      void vscode.window.showWarningMessage("当前存在活动共享或续期同步，请先停止后再重新生成共享 ID。 ");
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
    this.accountUsageState = createEmptyAccountUsageState();
    await this.persistState();
    await this.persistAccountUsageState();
    this.onChanged();
    void vscode.window.showInformationMessage(`已生成新的共享 ID：${profile.userId}`);
  }

  async shareAccountsWithPrompt(accountIds: readonly string[], language: DashboardLanguage): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
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
    await this.startCredentialSyncWithPeer(accountIds, selectedPeer.peer.userId);
  }

  async shareAccountsWithPeer(accountIds: readonly string[], peerUserId: string, expiresAt: number): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
    const peer = this.getTrustedPeers().find((candidate) => candidate.userId === peerUserId.trim());
    if (!peer) {
      throw new Error("共享对象尚未接受好友请求");
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("归还期限必须在当前时间之后");
    }
    await this.shareAccounts(accountIds, peer, expiresAt);
  }

  async startCredentialSyncWithPeer(accountIds: readonly string[], peerUserId: string): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
    await this.ensureRelayRegistration();
    const uniqueIds = [...new Set(accountIds)].filter(Boolean);
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_SHARED_ACCOUNTS) {
      throw new Error(`一次最多同步 ${MAX_SHARED_ACCOUNTS} 个账号`);
    }
    const peer = this.getTrustedPeers().find((candidate) => candidate.userId === peerUserId.trim());
    if (!peer) {
      throw new Error("同步对象尚未接受好友请求");
    }
    if (
      this.state!.credentialSyncs.some(
        (sync) => sync.peerUserId === peer.userId && sync.accountIds.some((id) => uniqueIds.includes(id))
      )
    ) {
      throw new Error("所选账号已经同步给该设备");
    }
    await this.request<{ credentialSyncs: CredentialSyncRelayRecord[] }>("/v1/sharing/credential-syncs/inbox");
    this.credentialSyncEndpointRetryAt = 0;
    const accounts = await Promise.all(uniqueIds.map((id) => this.repo.getAccount(id)));
    for (const account of accounts) {
      if (!account || isSub2ApiAccount(account)) {
        throw new Error("续期同步只支持已保存的 ChatGPT OAuth 账号");
      }
      const followerSync = this.state!.credentialSyncs.some(
        (sync) => sync.role === "follower" && sync.accountIds.includes(account.id)
      );
      if (account.sharing || account.credentialSync?.role === "follower" || followerSync) {
        throw new Error(`账号 ${account.email} 已处于共享或续期同步状态`);
      }
      const tokens = await this.repo.getTokens(account.id, { forceReload: true });
      if (!tokens?.accessToken || !tokens.idToken) {
        throw new Error(`账号 ${account.email} 缺少可用 OAuth 凭据`);
      }
      const fresh = await ensureFreshAccountTokens(this.repo, account.id, {
        fallbackTokens: tokens,
        providerAccountId: account.accountId
      });
      if (!fresh?.accessToken || !fresh.idToken) {
        throw new Error(`账号 ${account.email} 尚未取得可同步的当前凭据`);
      }
    }

    const exported = await this.repo.exportSharedAccounts(uniqueIds);
    if (exported.length !== uniqueIds.length) {
      throw new Error("部分账号缺少可同步的 OAuth 凭据");
    }
    const syncId = randomUUID();
    const followerAccounts = exported.map(withoutRefreshToken);
    const eventId = randomUUID();
    const snapshot: CredentialSyncPackage = {
      schema: CREDENTIAL_SYNC_PACKAGE_SCHEMA,
      syncId,
      version: 1,
      eventId,
      accounts: followerAccounts
    };
    const envelope = encryptSharingPayload(
      snapshot,
      this.keys!,
      this.getProfile().userId,
      peer.userId,
      peer.encryptionPublicKey,
      this.now()
    );
    const record: CredentialSyncRecord = {
      syncId,
      role: "primary",
      state: "pending",
      peerUserId: peer.userId,
      peerDisplayName: peer.displayName,
      accountIds: uniqueIds,
      version: 0,
      pendingUpdate: {
        initial: true,
        version: 1,
        eventId,
        envelope,
        credentialFingerprint: credentialSnapshotFingerprint(exported),
        attempts: 0
      },
      createdAt: this.now()
    };
    this.state!.credentialSyncs = [...this.state!.credentialSyncs, record];
    await this.persistState();
    await Promise.all(uniqueIds.map((accountId) => this.reconcileAccountCredentialSyncMarker(accountId)));

    try {
      await this.publishCredentialSyncRecord(record, exported);
    } catch (error) {
      console.warn(`[codexAccounts] credential sync is queued for retry: ${describeError(error)}`);
    }
    this.onChanged();
  }

  async stopCredentialSyncForAccount(accountId: string, syncId?: string): Promise<boolean> {
    this.assertInitialized();
    this.assertEnabled();
    await this.ensureRelayRegistration();
    const normalizedSyncId = syncId?.trim();
    const sync = this.state!.credentialSyncs.find(
      (candidate) =>
        candidate.accountIds.includes(accountId) &&
        (normalizedSyncId === undefined || normalizedSyncId.length === 0 || candidate.syncId === normalizedSyncId)
    );
    if (!sync) {
      return false;
    }
    await this.request(`/v1/sharing/credential-syncs/${encodeURIComponent(sync.syncId)}/stop`, { method: "POST" });
    await this.clearCredentialSyncLocally(sync, sync.role === "follower");
    this.onChanged();
    return true;
  }

  async shareAccounts(accountIds: readonly string[], peer: SharingPeer, expiresAt: number): Promise<void> {
    this.assertInitialized();
    this.assertEnabled();
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
    const alreadyShared = existing.find(
      (account) => account?.sharing !== undefined || account?.credentialSync !== undefined
    );
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
    this.assertEnabled();
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
    // The encrypted return package is already durable in Relay. Remove the
    // follower-side account immediately after the server accepts the return;
    // owner acknowledgement only completes the local lease bookkeeping.
    await this.removeIncomingLeaseAccounts(lease, targetIds);
    await this.applyIncomingReturnConfirmation(lease, transfer.ownerConfirmedAccountIds);
    await this.persistState();
    this.onChanged();
    return true;
  }

  async returnAccount(accountId: string): Promise<boolean> {
    this.assertInitialized();
    this.assertEnabled();
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
    this.assertEnabled();
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
    await this.reconcileTerminalOutgoingLeases();
    await this.pollLeaseConditions();
    await this.pollCredentialSyncs();
  }

  private async pollCredentialSyncs(): Promise<void> {
    if (this.credentialSyncEndpointRetryAt > this.now()) {
      return;
    }
    let changed = false;
    let publishError: unknown;
    let usageChanged = false;
    let incoming: {
      credentialSyncs: CredentialSyncRelayRecord[];
      usageRequests?: AccountUsageReadRequest[];
      usageUpdates?: AccountUsageUpdate[];
    };
    try {
      incoming = await this.request<{
        credentialSyncs: CredentialSyncRelayRecord[];
        usageRequests?: AccountUsageReadRequest[];
        usageUpdates?: AccountUsageUpdate[];
      }>("/v1/sharing/credential-syncs/inbox");
      this.credentialSyncEndpointRetryAt = 0;
    } catch (error) {
      if (readStatusCode(error) === 404) {
        this.credentialSyncEndpointRetryAt = this.now() + 60_000;
        if (this.state!.credentialSyncs.length === 0) {
          return;
        }
      }
      throw error;
    }
    this.processIncomingAccountUsageRequests(incoming.usageRequests ?? []);
    usageChanged = await this.processIncomingAccountUsageUpdates(incoming.usageUpdates ?? []);
    for (const remote of incoming.credentialSyncs ?? []) {
      const local = this.state!.credentialSyncs.find((candidate) => candidate.syncId === remote.syncId);
      if (remote.state === "stopped") {
        if (local?.role === "follower") {
          await this.clearCredentialSyncLocally(local, true);
          changed = true;
        }
        await this.acknowledgeCredentialSyncStop(remote);
        continue;
      }

      const peer = this.state!.peers.find(
        (candidate) => candidate.userId === remote.fromUserId && candidate.relationship === "trusted"
      );
      if (!peer) {
        const stopped = await this.request<CredentialSyncRelayRecord>(
          `/v1/sharing/credential-syncs/${encodeURIComponent(remote.syncId)}/stop`,
          { method: "POST" }
        );
        await this.acknowledgeCredentialSyncStop(stopped);
        continue;
      }
      if (local?.role === "primary") {
        continue;
      }
      if (local && remote.version <= local.version) {
        if ((local.acknowledgedVersion ?? 0) < local.version) {
          await this.acknowledgeCredentialSyncVersion(local, local.version);
          changed = true;
        }
        continue;
      }

      const packageValue = this.decryptCredentialSyncSnapshot(remote, peer);
      const accountIds = await this.applyCredentialSyncSnapshot(packageValue, remote.syncId, peer);
      if (local) {
        local.version = remote.version;
        local.acknowledgedVersion = local.acknowledgedVersion ?? 0;
        local.accountIds = accountIds;
      } else {
        const record: CredentialSyncRecord = {
          syncId: remote.syncId,
          role: "follower",
          state: "active",
          peerUserId: peer.userId,
          peerDisplayName: peer.displayName,
          accountIds,
          version: remote.version,
          acknowledgedVersion: 0,
          createdAt: remote.createdAt
        };
        this.state!.credentialSyncs.push(record);
      }
      await this.persistState();
      await this.acknowledgeCredentialSyncVersion(
        local ?? this.state!.credentialSyncs.find((candidate) => candidate.syncId === remote.syncId)!,
        remote.version
      );
      changed = true;
    }

    for (const pending of this.state!.credentialSyncs.filter(
      (sync) => sync.role === "primary" && sync.state === "pending"
    )) {
      try {
        const before = JSON.stringify(pending);
        await this.publishCredentialSyncRecord(pending);
        changed ||= before !== JSON.stringify(pending);
      } catch (error) {
        console.warn(`[codexAccounts] initial credential sync queued: ${describeError(error)}`);
        publishError ??= error;
      }
    }

    const sent = await this.request<{
      credentialSyncs: CredentialSyncRelayRecord[];
      usageRequests?: AccountUsageReadRequest[];
      usageUpdates?: AccountUsageUpdate[];
    }>("/v1/sharing/credential-syncs/sent");
    usageChanged ||= await this.processSentAccountUsageRequests(sent.usageRequests ?? []);
    for (const remote of sent.credentialSyncs ?? []) {
      const local = this.state!.credentialSyncs.find(
        (candidate) => candidate.syncId === remote.syncId && candidate.role === "primary"
      );
      if (!local) {
        if (remote.state === "stopped") {
          await this.acknowledgeCredentialSyncStop(remote);
        }
        continue;
      }
      if (remote.state === "stopped") {
        await this.clearCredentialSyncLocally(local);
        await this.acknowledgeCredentialSyncStop(remote);
        changed = true;
        continue;
      }
      try {
        const before = JSON.stringify(local);
        const latest = await this.repo.exportSharedAccounts(local.accountIds);
        await this.publishCredentialSyncRecord(local, latest, remote);
        changed ||= before !== JSON.stringify(local);
      } catch (error) {
        console.warn(`[codexAccounts] credential sync update queued: ${describeError(error)}`);
        publishError ??= error;
      }
    }
    this.scheduleFollowerAccountUsageUpdates();
    if (changed || usageChanged) {
      await this.persistState();
      this.onChanged();
    }
    if (publishError) {
      throw new Error(`Credential sync update failed: ${describeError(publishError)}`);
    }
  }

  private processIncomingAccountUsageRequests(requests: readonly AccountUsageReadRequest[]): void {
    const followerSyncs = this.state!.credentialSyncs.filter(
      (sync) => sync.role === "follower" && sync.state === "active"
    );
    if (followerSyncs.length === 0 || requests.length === 0) {
      return;
    }
    for (const request of requests) {
      const sync = followerSyncs.find((candidate) => candidate.syncId === request.syncId);
      if (!sync || request.state !== "pending") {
        continue;
      }
      if (this.accountUsageResponseInFlight.has(request.id)) {
        continue;
      }
      const peer = this.state!.peers.find(
        (candidate) => candidate.userId === sync.peerUserId && candidate.relationship === "trusted"
      );
      if (!peer) {
        continue;
      }
      const task = this.respondToAccountUsageRequest(
        request,
        { ...sync, accountIds: [...sync.accountIds] },
        peer
      ).catch((error: unknown) => {
        console.warn(`[codexAccounts] account usage response queued: ${describeError(error)}`);
      });
      this.accountUsageResponseInFlight.set(request.id, task);
      void task.then(() => {
        if (this.accountUsageResponseInFlight.get(request.id) === task) {
          this.accountUsageResponseInFlight.delete(request.id);
        }
      });
    }
  }

  private async respondToAccountUsageRequest(
    request: AccountUsageReadRequest,
    sync: CredentialSyncRecord,
    peer: SharingPeer
  ): Promise<void> {
    const packageValue = await this.buildAccountUsagePackage(sync, request.id);
    const eventId = randomUUID();
    const envelope = encryptSharingPayload(
      packageValue,
      this.keys!,
      this.getProfile().userId,
      peer.userId,
      peer.encryptionPublicKey,
      this.now()
    );
    await this.request(`/v1/sharing/usage-requests/${encodeURIComponent(request.id)}/response`, {
      method: "POST",
      body: JSON.stringify({
        revision: packageValue.revision,
        eventId,
        envelope
      })
    });
  }

  private async processSentAccountUsageRequests(requests: readonly AccountUsageReadRequest[]): Promise<boolean> {
    let changed = false;
    let stateChanged = false;
    let sawValidResponse = false;
    let firstError: string | undefined;
    const acknowledgements: Array<{ key: string; operation: () => Promise<void> }> = [];
    const expired = this.accountUsageState.pendingRequests.filter((request) => request.expiresAt <= this.now());
    if (expired.length > 0) {
      this.accountUsageState.pendingRequests = this.accountUsageState.pendingRequests.filter(
        (request) => request.expiresAt > this.now()
      );
      this.accountUsageLastError = "从设备未响应";
      await this.persistAccountUsageState();
      changed = true;
      stateChanged = true;
    }
    const candidates: Array<{ request: AccountUsageReadRequest; sync: CredentialSyncRecord; peer: SharingPeer }> = [];
    for (const request of requests) {
      if (request.state !== "responded" || !request.response) {
        continue;
      }
      const sync = this.state!.credentialSyncs.find(
        (candidate) =>
          candidate.syncId === request.syncId && candidate.role === "primary" && candidate.state === "active"
      );
      if (!sync) {
        acknowledgements.push({
          key: `request:${request.id}`,
          operation: () => this.acknowledgeAccountUsageRequest(request.id)
        });
        continue;
      }
      const peer = this.state!.peers.find(
        (candidate) => candidate.userId === sync.peerUserId && candidate.relationship === "trusted"
      );
      if (peer) {
        candidates.push({ request, sync, peer });
      }
    }
    const decoded = await Promise.allSettled(
      candidates.map((candidate) =>
        Promise.resolve().then(() => ({
          ...candidate,
          packageValue: this.decryptAccountUsagePackage(candidate.request, candidate.peer)
        }))
      )
    );
    for (const result of decoded) {
      if (result.status === "rejected") {
        firstError ??= describeError(result.reason);
        continue;
      }
      sawValidResponse = true;
      const { request, sync, peer, packageValue } = result.value;
      const existing = this.accountUsageState.sources.find((source) => source.syncId === sync.syncId);
      if (!existing || packageValue.revision > existing.revision) {
        this.accountUsageState.sources = [
          ...this.accountUsageState.sources.filter((source) => source.syncId !== sync.syncId),
          {
            syncId: sync.syncId,
            sourceUserId: sync.peerUserId,
            sourceDisplayName: peer.note?.trim() || peer.displayName,
            revision: packageValue.revision,
            calculatedAt: packageValue.calculatedAt,
            receivedAt: this.now(),
            accounts: packageValue.accounts
          }
        ];
        changed = true;
        stateChanged = true;
      }
      const pendingCount = this.accountUsageState.pendingRequests.length;
      this.accountUsageState.pendingRequests = this.accountUsageState.pendingRequests.filter(
        (pending) => pending.requestId !== request.id
      );
      if (this.accountUsageState.pendingRequests.length !== pendingCount) {
        changed = true;
        stateChanged = true;
      }
      acknowledgements.push({
        key: `request:${request.id}`,
        operation: () => this.acknowledgeAccountUsageRequest(request.id)
      });
    }
    if (firstError) {
      changed ||= this.accountUsageLastError !== firstError;
      this.accountUsageLastError = firstError;
      console.warn(`[codexAccounts] account usage response failed: ${firstError}`);
    } else if (sawValidResponse && this.accountUsageLastError !== undefined) {
      this.accountUsageLastError = undefined;
      changed = true;
    }
    if (stateChanged) {
      await this.persistAccountUsageState();
    }
    for (const acknowledgement of acknowledgements) {
      this.enqueueAccountUsageAck(acknowledgement.key, acknowledgement.operation);
    }
    return changed;
  }

  private async processIncomingAccountUsageUpdates(updates: readonly AccountUsageUpdate[]): Promise<boolean> {
    let changed = false;
    let stateChanged = false;
    let sawValidUpdate = false;
    let firstError: string | undefined;
    const acknowledgements: Array<{ key: string; operation: () => Promise<void> }> = [];
    const candidates: Array<{ update: AccountUsageUpdate; sync: CredentialSyncRecord; peer: SharingPeer }> = [];
    for (const update of updates) {
      const sync = this.state!.credentialSyncs.find(
        (candidate) =>
          candidate.syncId === update.syncId && candidate.role === "primary" && candidate.state === "active"
      );
      if (!sync) {
        acknowledgements.push({
          key: `update:${update.syncId}:${update.revision}`,
          operation: () => this.acknowledgeAccountUsageUpdate(update.syncId, update.revision)
        });
        continue;
      }
      const peer = this.state!.peers.find(
        (candidate) => candidate.userId === sync.peerUserId && candidate.relationship === "trusted"
      );
      if (peer) {
        candidates.push({ update, sync, peer });
      }
    }
    const decoded = await Promise.allSettled(
      candidates.map((candidate) =>
        Promise.resolve().then(() => ({
          ...candidate,
          packageValue: this.decryptAccountUsagePackage(candidate.update, candidate.peer)
        }))
      )
    );
    for (const result of decoded) {
      if (result.status === "rejected") {
        firstError ??= describeError(result.reason);
        continue;
      }
      sawValidUpdate = true;
      const { update, sync, peer, packageValue } = result.value;
      const existing = this.accountUsageState.sources.find((source) => source.syncId === sync.syncId);
      if (!existing || packageValue.revision > existing.revision) {
        this.accountUsageState.sources = [
          ...this.accountUsageState.sources.filter((source) => source.syncId !== sync.syncId),
          {
            syncId: sync.syncId,
            sourceUserId: sync.peerUserId,
            sourceDisplayName: peer.note?.trim() || peer.displayName,
            revision: packageValue.revision,
            calculatedAt: packageValue.calculatedAt,
            receivedAt: this.now(),
            accounts: packageValue.accounts
          }
        ];
        changed = true;
        stateChanged = true;
      }
      acknowledgements.push({
        key: `update:${update.syncId}:${update.revision}`,
        operation: () => this.acknowledgeAccountUsageUpdate(update.syncId, update.revision)
      });
    }
    if (firstError) {
      changed ||= this.accountUsageLastError !== firstError;
      this.accountUsageLastError = firstError;
      console.warn(`[codexAccounts] automatic account usage update failed: ${firstError}`);
    } else if (sawValidUpdate && this.accountUsageLastError !== undefined) {
      this.accountUsageLastError = undefined;
      changed = true;
    }
    if (stateChanged) {
      await this.persistAccountUsageState();
    }
    for (const acknowledgement of acknowledgements) {
      this.enqueueAccountUsageAck(acknowledgement.key, acknowledgement.operation);
    }
    return changed;
  }

  private scheduleFollowerAccountUsageUpdates(): void {
    const syncs = this.state!.credentialSyncs.filter((sync) => sync.role === "follower" && sync.state === "active");
    for (const sync of syncs) {
      if (this.accountUsagePublishInFlight.has(sync.syncId)) {
        continue;
      }
      const task = this.publishFollowerAccountUsageUpdate({ ...sync, accountIds: [...sync.accountIds] }).catch(
        (error: unknown) => {
          console.warn(`[codexAccounts] automatic account usage update queued: ${describeError(error)}`);
        }
      );
      this.accountUsagePublishInFlight.set(sync.syncId, task);
      void task.then(() => {
        if (this.accountUsagePublishInFlight.get(sync.syncId) === task) {
          this.accountUsagePublishInFlight.delete(sync.syncId);
        }
      });
    }
  }

  private async publishFollowerAccountUsageUpdate(sync: CredentialSyncRecord): Promise<void> {
    const snapshot = await readCachedAccountTokenUsage(getPrivateStatePaths(this.context).root);
    if (!Number.isFinite(snapshot?.calculatedAt)) {
      return;
    }
    const current = this.state!.credentialSyncs.find(
      (candidate) => candidate.syncId === sync.syncId && candidate.role === "follower" && candidate.state === "active"
    );
    if (!current) {
      return;
    }
    const revision = Math.max(0, Math.floor(snapshot!.calculatedAt!));
    const now = this.now();
    const previous = this.accountUsagePublishedRevisions.get(sync.syncId);
    if (
      previous &&
      (revision <= previous.revision || now - previous.publishedAt < this.getAccountUsageSyncIntervalMs())
    ) {
      return;
    }
    const peer = this.state!.peers.find(
      (candidate) => candidate.userId === sync.peerUserId && candidate.relationship === "trusted"
    );
    if (!peer) {
      return;
    }
    const packageValue = await this.buildAccountUsagePackage(sync, undefined, snapshot);
    const eventId = randomUUID();
    const envelope = encryptSharingPayload(
      packageValue,
      this.keys!,
      this.getProfile().userId,
      peer.userId,
      peer.encryptionPublicKey,
      now
    );
    const accepted = await this.request<AccountUsageUpdate>("/v1/sharing/usage-updates", {
      method: "POST",
      body: JSON.stringify({
        syncId: sync.syncId,
        revision: packageValue.revision,
        eventId,
        envelope
      })
    });
    this.accountUsagePublishedRevisions.set(sync.syncId, {
      revision: accepted.revision,
      publishedAt: this.now()
    });
  }

  private enqueueAccountUsageAck(key: string, operation: () => Promise<void>): void {
    if (this.accountUsageAckInFlight.has(key)) {
      return;
    }
    const task = operation().catch((error: unknown) => {
      console.warn(`[codexAccounts] account usage acknowledgement queued: ${describeError(error)}`);
    });
    this.accountUsageAckInFlight.set(key, task);
    void task.then(() => {
      if (this.accountUsageAckInFlight.get(key) === task) {
        this.accountUsageAckInFlight.delete(key);
      }
    });
  }

  private async buildAccountUsagePackage(
    sync: CredentialSyncRecord,
    requestId?: string,
    snapshot?: AccountTokenUsageSnapshot
  ): Promise<AccountUsagePackage> {
    snapshot ??= await readCachedAccountTokenUsage(getPrivateStatePaths(this.context).root);
    const accounts = await Promise.all(
      sync.accountIds.map(async (accountId) => {
        const account = await this.repo.getAccount(accountId).catch(() => undefined);
        if (!account) {
          return { accountId };
        }
        return {
          accountId,
          tokenUsage: resolveAccountTokenUsage(account, snapshot),
          lifetimeTokenUsage: resolveAccountLifetimeTokenUsage(account, snapshot)
        };
      })
    );
    return {
      schema: ACCOUNT_USAGE_PACKAGE_SCHEMA,
      syncId: sync.syncId,
      requestId,
      revision: Math.max(0, Math.floor(snapshot?.calculatedAt ?? 0)),
      calculatedAt: snapshot?.calculatedAt,
      accounts
    };
  }

  private decryptAccountUsagePackage(
    request: AccountUsageReadRequest | AccountUsageUpdate,
    peer: SharingPeer
  ): AccountUsagePackage {
    const isReadRequest = !("envelope" in request);
    const envelope = isReadRequest ? request.response?.envelope : request.envelope;
    const expectedRequestId = isReadRequest ? request.id : undefined;
    if (!envelope) {
      throw new Error("account usage package envelope is missing");
    }
    const value = decryptSharingPayload(envelope, this.keys!, this.getProfile().userId, {
      userId: peer.userId,
      identityPublicKey: peer.identityPublicKey
    }) as AccountUsagePackage;
    if (
      value?.schema !== ACCOUNT_USAGE_PACKAGE_SCHEMA ||
      value.syncId !== request.syncId ||
      (expectedRequestId === undefined ? value.requestId !== undefined : value.requestId !== expectedRequestId) ||
      !Number.isSafeInteger(value.revision) ||
      (value.calculatedAt !== undefined && !Number.isFinite(value.calculatedAt)) ||
      !Array.isArray(value.accounts) ||
      value.accounts.length > MAX_SHARED_ACCOUNTS ||
      value.accounts.some((entry) => !isAccountUsagePackageEntry(entry))
    ) {
      throw new Error("account usage package is invalid");
    }
    const sync = this.state!.credentialSyncs.find((candidate) => candidate.syncId === request.syncId);
    const allowed = new Set(sync?.accountIds ?? []);
    if (
      value.accounts.some((entry) => !entry || typeof entry.accountId !== "string" || !allowed.has(entry.accountId))
    ) {
      throw new Error("account usage package contains an unexpected account");
    }
    return value;
  }

  private async acknowledgeAccountUsageRequest(requestId: string): Promise<void> {
    await this.request(`/v1/sharing/usage-requests/${encodeURIComponent(requestId)}/ack`, { method: "POST" });
  }

  private async acknowledgeAccountUsageUpdate(syncId: string, revision: number): Promise<void> {
    await this.request(`/v1/sharing/usage-updates/${encodeURIComponent(syncId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ revision })
    });
  }

  private getAccountUsageSyncIntervalMs(): number {
    const configured = vscode.workspace
      .getConfiguration("codexAccounts")
      .get<number>("sharedUsageSyncIntervalMinutes", 10);
    const minutes = Number.isFinite(configured) ? Math.floor(configured) : 10;
    return Math.min(60, Math.max(10, minutes)) * 60 * 1_000;
  }

  private async persistAccountUsageState(): Promise<void> {
    const write = this.accountUsageStateWriteInFlight.then(() =>
      writeAccountUsageState(getPrivateStatePaths(this.context).root, this.accountUsageState)
    );
    this.accountUsageStateWriteInFlight = write.catch(() => undefined);
    await write;
  }

  private getDashboardAccountUsageSources(): DashboardAccountUsageSourceViewModel[] {
    const activePrimarySyncs = new Set(
      this.state!.credentialSyncs.filter((sync) => sync.role === "primary" && sync.state === "active").map(
        (sync) => sync.syncId
      )
    );
    return this.accountUsageState.sources
      .filter((source) => activePrimarySyncs.has(source.syncId))
      .flatMap((source) =>
        source.accounts.map((account) => ({
          accountId: account.accountId,
          syncId: source.syncId,
          sourceUserId: source.sourceUserId,
          sourceLabel: source.sourceDisplayName || source.sourceUserId,
          sourceRole: "follower" as const,
          calculatedAt: source.calculatedAt,
          receivedAt: source.receivedAt,
          stale: source.calculatedAt === undefined || this.now() - source.calculatedAt > 30 * 60 * 1000,
          tokenUsage: account.tokenUsage,
          lifetimeTokenUsage: account.lifetimeTokenUsage
        }))
      );
  }

  private async publishCredentialSyncRecord(
    sync: CredentialSyncRecord,
    exported?: SharedCodexAccountJson[],
    relaySnapshot?: CredentialSyncRelayRecord
  ): Promise<void> {
    await withRenewingSchedulerLease(this.repo, `credential-sync-${sync.syncId}`, 60_000, 0, async (leaseIsActive) => {
      if (leaseIsActive()) {
        await this.publishCredentialSyncRecordLocked(sync, exported, relaySnapshot);
      }
    });
  }

  private async publishCredentialSyncRecordLocked(
    sync: CredentialSyncRecord,
    exported?: SharedCodexAccountJson[],
    relaySnapshot?: CredentialSyncRelayRecord
  ): Promise<void> {
    const currentExport = exported ?? (await this.repo.exportSharedAccounts(sync.accountIds));
    if (currentExport.length !== sync.accountIds.length) {
      throw new Error("A primary sync account is no longer available locally");
    }
    const credentialFingerprint = credentialSnapshotFingerprint(currentExport);
    if (sync.state === "pending") {
      const pending = sync.pendingUpdate;
      if (!pending?.initial) {
        throw new Error("Initial credential sync snapshot is missing");
      }
      if (pending.nextAttemptAt && pending.nextAttemptAt > this.now()) {
        return;
      }
      try {
        const created = await this.request<CredentialSyncRelayRecord>("/v1/sharing/credential-syncs", {
          method: "POST",
          body: JSON.stringify({
            syncId: sync.syncId,
            recipientUserId: sync.peerUserId,
            version: pending.version,
            eventId: pending.eventId,
            envelope: pending.envelope
          })
        });
        sync.state = "active";
        sync.version = created.version;
        sync.credentialFingerprint = pending.credentialFingerprint;
        sync.pendingUpdate = undefined;
        await this.persistState();
        return;
      } catch (error) {
        await this.scheduleCredentialSyncRetry(sync, pending);
        throw error;
      }
    }

    if (
      relaySnapshot?.state === "active" &&
      !sync.pendingUpdate &&
      sync.credentialFingerprint === credentialFingerprint &&
      relaySnapshot.version >= sync.version
    ) {
      if (relaySnapshot.version !== sync.version) {
        sync.version = relaySnapshot.version;
        await this.persistState();
      }
      return;
    }
    const remote = await this.request<CredentialSyncRelayRecord>(
      `/v1/sharing/credential-syncs/${encodeURIComponent(sync.syncId)}`
    );
    if (remote.state === "stopped") {
      await this.clearCredentialSyncLocally(sync);
      await this.acknowledgeCredentialSyncStop(remote);
      return;
    }
    let pending = sync.pendingUpdate;
    if (pending?.version === remote.version && pending?.eventId === remote.eventId) {
      sync.version = remote.version;
      sync.credentialFingerprint = pending.credentialFingerprint;
      sync.pendingUpdate = undefined;
      pending = undefined;
      await this.persistState();
    } else if (remote.version > sync.version) {
      sync.version = remote.version;
      if (pending && pending.version <= remote.version) {
        sync.pendingUpdate = undefined;
        pending = undefined;
      }
    }

    if (pending && pending.credentialFingerprint !== credentialFingerprint) {
      pending = this.createPendingCredentialSyncUpdate(
        sync,
        currentExport,
        credentialFingerprint,
        Math.max(sync.version, pending.version) + 1
      );
      sync.pendingUpdate = pending;
      await this.persistState();
    } else if (!pending && sync.credentialFingerprint !== credentialFingerprint) {
      pending = this.createPendingCredentialSyncUpdate(
        sync,
        currentExport,
        credentialFingerprint,
        Math.max(sync.version, remote.version) + 1
      );
      sync.pendingUpdate = pending;
      await this.persistState();
    }
    if (!pending || (pending.nextAttemptAt && pending.nextAttemptAt > this.now())) {
      return;
    }
    try {
      const updated = await this.request<CredentialSyncRelayRecord>(
        `/v1/sharing/credential-syncs/${encodeURIComponent(sync.syncId)}/snapshot`,
        {
          method: "PUT",
          body: JSON.stringify({
            version: pending.version,
            eventId: pending.eventId,
            envelope: pending.envelope
          })
        }
      );
      sync.version = updated.version;
      sync.credentialFingerprint = pending.credentialFingerprint;
      sync.pendingUpdate = undefined;
      await this.persistState();
    } catch (error) {
      await this.scheduleCredentialSyncRetry(sync, pending);
      throw error;
    }
  }

  private createPendingCredentialSyncUpdate(
    sync: CredentialSyncRecord,
    exported: SharedCodexAccountJson[],
    credentialFingerprint: string,
    version: number
  ): CredentialSyncPendingUpdate {
    const peer = this.state!.peers.find(
      (candidate) => candidate.userId === sync.peerUserId && candidate.relationship === "trusted"
    );
    if (!peer) {
      throw new Error("Credential sync peer is no longer trusted");
    }
    const eventId = randomUUID();
    const snapshot: CredentialSyncPackage = {
      schema: CREDENTIAL_SYNC_PACKAGE_SCHEMA,
      syncId: sync.syncId,
      version,
      eventId,
      accounts: exported.map(withoutRefreshToken)
    };
    return {
      version,
      eventId,
      envelope: encryptSharingPayload(
        snapshot,
        this.keys!,
        this.getProfile().userId,
        peer.userId,
        peer.encryptionPublicKey,
        this.now()
      ),
      credentialFingerprint,
      attempts: 0
    };
  }

  private async scheduleCredentialSyncRetry(
    sync: CredentialSyncRecord,
    pending: CredentialSyncPendingUpdate
  ): Promise<void> {
    pending.attempts += 1;
    const backoff = Math.min(CREDENTIAL_SYNC_RETRY_MAX_MS, 1_000 * 2 ** Math.min(pending.attempts, 8));
    pending.nextAttemptAt = this.now() + Math.floor(backoff * (0.8 + Math.random() * 0.4));
    sync.pendingUpdate = pending;
    await this.persistState();
  }

  private decryptCredentialSyncSnapshot(remote: CredentialSyncRelayRecord, peer: SharingPeer): CredentialSyncPackage {
    const value = decryptSharingPayload(remote.envelope, this.keys!, this.getProfile().userId, {
      userId: peer.userId,
      identityPublicKey: peer.identityPublicKey
    }) as CredentialSyncPackage;
    validateCredentialSyncPackage(value, remote.syncId, remote.version, remote.eventId);
    return value;
  }

  private async applyCredentialSyncSnapshot(
    snapshot: CredentialSyncPackage,
    syncId: string,
    peer: SharingPeer
  ): Promise<string[]> {
    await this.assertNoCredentialSyncConflict(snapshot.accounts, syncId);
    const existingAccounts = await this.repo.listAccounts();
    const newEntries: SharedCodexAccountJson[] = [];
    const accountIds: string[] = [];
    const syncInfo: CodexAccountCredentialSyncInfo = {
      syncId,
      role: "follower",
      peerUserId: peer.userId,
      peerDisplayName: peer.displayName,
      since: this.now()
    };
    for (const entry of snapshot.accounts) {
      const storageId = previewSharedEntry(entry).storageId;
      if (!storageId) {
        throw new Error("credential sync account identity is invalid");
      }
      const existing = existingAccounts.find((account) => account.id === storageId);
      if (!existing) {
        newEntries.push(withoutRefreshToken(entry));
        accountIds.push(storageId);
        continue;
      }
      if (
        existing.sharing ||
        (existing.credentialSync &&
          (existing.credentialSync.syncId !== syncId || existing.credentialSync.role !== "follower"))
      ) {
        throw new Error(`account ${existing.email} is already assigned to another sharing relationship`);
      }
      const tokens = restoreSharedTokens(entry);
      tokens.refreshToken = undefined;
      if (existing.credentialSync?.syncId !== syncId || existing.credentialSync.role !== "follower") {
        await this.repo.setAccountCredentialSyncInfo(existing.id, syncInfo);
      }
      await this.repo.updateTokens(existing.id, tokens);
      accountIds.push(existing.id);
    }

    if (newEntries.length > 0) {
      const summary = await importSharedAccountsIntoBalancePool(this.repo, newEntries, undefined, syncInfo);
      if (summary.imported !== newEntries.length) {
        throw new Error("some credential sync accounts could not be imported");
      }
      accountIds.push(
        ...summary.accounts
          .map((account) => account.accountId)
          .filter((accountId): accountId is string => Boolean(accountId))
      );
    }
    return [...new Set(accountIds)];
  }

  private async assertNoCredentialSyncConflict(
    entries: readonly SharedCodexAccountJson[],
    syncId: string
  ): Promise<void> {
    const existing = await this.repo.listAccounts();
    for (const entry of entries) {
      const preview = previewSharedEntry(entry);
      const providerAccountId = typeof entry.account_id === "string" ? entry.account_id.trim() : undefined;
      const conflict = existing.find(
        (account) =>
          account.email.trim().toLowerCase() === preview.email?.trim().toLowerCase() ||
          (providerAccountId !== undefined && account.accountId === providerAccountId)
      );
      if (conflict && conflict.id !== preview.storageId) {
        throw new Error(`接收端的账号 ${conflict.email} 与同步账号身份不匹配`);
      }
      if (conflict && (conflict.sharing || (conflict.credentialSync && conflict.credentialSync.syncId !== syncId))) {
        throw new Error(`账号 ${conflict.email} 已处于其他共享或续期同步中`);
      }
    }
  }

  private async acknowledgeCredentialSyncVersion(sync: CredentialSyncRecord, version: number): Promise<void> {
    await this.request(`/v1/sharing/credential-syncs/${encodeURIComponent(sync.syncId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ version })
    });
    sync.acknowledgedVersion = Math.max(sync.acknowledgedVersion ?? 0, version);
    await this.persistState();
  }

  private async acknowledgeCredentialSyncStop(remote: CredentialSyncRelayRecord): Promise<void> {
    await this.request(`/v1/sharing/credential-syncs/${encodeURIComponent(remote.syncId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ version: remote.version })
    });
  }

  private async clearCredentialSyncLocally(sync: CredentialSyncRecord, removeFollowerAccounts = false): Promise<void> {
    const accountIds = [...sync.accountIds];
    // Remove the relationship from memory before touching the repository.
    // Repository notifications can schedule a poll while follower accounts
    // are being deleted; that poll must not re-enter this stopped sync.
    this.state!.credentialSyncs = this.state!.credentialSyncs.filter((candidate) => candidate.syncId !== sync.syncId);
    if (removeFollowerAccounts && sync.role === "follower") {
      for (const accountId of accountIds) {
        const account = await this.repo.getAccount(accountId).catch(() => undefined);
        if (account?.credentialSync?.syncId !== sync.syncId || account.credentialSync.role !== "follower") {
          continue;
        }
        await this.repo.setAccountCredentialSyncInfo(accountId, undefined);
        await this.repo.removeAccount(accountId);
      }
    }
    for (const accountId of sync.accountIds) {
      const account = await this.repo.getAccount(accountId).catch(() => undefined);
      if (!removeFollowerAccounts && account?.credentialSync?.syncId === sync.syncId) {
        await this.repo.setAccountCredentialSyncInfo(accountId, undefined);
      }
    }
    if (!removeFollowerAccounts) {
      await Promise.all(accountIds.map((accountId) => this.reconcileAccountCredentialSyncMarker(accountId)));
    }
    await this.persistState();
    this.accountUsageState.sources = this.accountUsageState.sources.filter((source) => source.syncId !== sync.syncId);
    this.accountUsageState.pendingRequests = this.accountUsageState.pendingRequests.filter(
      (request) => request.syncId !== sync.syncId
    );
    await this.persistAccountUsageState();
  }

  private async reconcileAccountCredentialSyncMarker(accountId: string): Promise<void> {
    const account = await this.repo.getAccount(accountId).catch(() => undefined);
    if (!account) {
      return;
    }
    const sync = this.state!.credentialSyncs.find((candidate) => candidate.accountIds.includes(accountId));
    const next = sync
      ? {
          syncId: sync.syncId,
          role: sync.role,
          peerUserId: sync.peerUserId,
          peerDisplayName: sync.peerDisplayName,
          since: sync.createdAt
        }
      : undefined;
    const current = account.credentialSync;
    if (
      current?.syncId === next?.syncId &&
      current?.role === next?.role &&
      current?.peerUserId === next?.peerUserId &&
      current?.peerDisplayName === next?.peerDisplayName &&
      current?.since === next?.since
    ) {
      return;
    }
    await this.repo.setAccountCredentialSyncInfo(accountId, next);
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
        if (
          acknowledged.state === "cancelled" ||
          acknowledged.state === "returned" ||
          acknowledged.state === "failed"
        ) {
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

  /**
   * A terminal Relay transfer can disappear from the sent-transfer listing
   * after the owner has already recorded the lease as returned. Reconcile the
   * owner-side account marker from the durable pre-share snapshot so a lost
   * final poll cannot leave an account permanently hidden and unavailable.
   */
  private async reconcileTerminalOutgoingLeases(): Promise<boolean> {
    let changed = false;
    for (const lease of this.state!.leases) {
      if (lease.direction !== "outgoing" || !["returned", "failed"].includes(lease.state)) {
        continue;
      }
      const staleAccountIds: string[] = [];
      for (const accountId of this.getOwnerLeaseAccountIds(lease)) {
        const account = await this.repo.getAccount(accountId).catch(() => undefined);
        if (account?.sharing?.leaseId === lease.leaseId) {
          staleAccountIds.push(accountId);
        }
      }
      if (staleAccountIds.length === 0) {
        continue;
      }
      const outcome = lease.state === "failed" ? "failed" : "returned";
      changed = (await this.finalizeOutgoingAccounts(lease, staleAccountIds, outcome)) || changed;
    }
    if (changed) {
      await this.persistState();
      this.onChanged();
    }
    return changed;
  }

  private getOwnerLeaseAccountIds(lease: SharingLease): string[] {
    return [
      ...new Set([
        ...lease.accountIds,
        ...(lease.ownerAccountStates?.map((entry) => entry.accountId) ?? []),
        ...(lease.returnAckAccountIds ?? [])
      ])
    ];
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
      const packageValue = decryptSharingPayload(returned.envelope, this.keys!, this.getProfile().userId, {
        userId: peer.userId,
        identityPublicKey: peer.identityPublicKey
      }) as SharingReturnPackage;
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
      const ownerLeaseAccountIds = new Set(this.getOwnerLeaseAccountIds(lease));
      const targetIds = [...appliedAccountIds].filter((accountId) => ownerLeaseAccountIds.has(accountId));
      if (targetIds.length > 0) {
        await this.finalizeOutgoingAccounts(lease, targetIds);
      }
      lease.returnAckAccountIds = Array.from(new Set([...(lease.returnAckAccountIds ?? []), ...appliedAccountIds]));
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

  private isCredentialSyncAccount(accountId: string): boolean {
    return Boolean(this.state?.credentialSyncs.some((sync) => sync.accountIds.includes(accountId)));
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
  ): Promise<boolean> {
    const knownAccountIds = this.getOwnerLeaseAccountIds(lease);
    const targetIds = returnedAccountIds?.length
      ? knownAccountIds.filter((accountId) => returnedAccountIds.includes(accountId))
      : knownAccountIds;
    const finalizedAccountIds: string[] = [];
    for (const accountId of targetIds) {
      const account = await this.repo.getAccount(accountId).catch(() => undefined);
      if (!account) {
        finalizedAccountIds.push(accountId);
        continue;
      }
      if (account.sharing?.leaseId !== lease.leaseId) {
        continue;
      }
      await this.repo.setAccountSharingInfo(accountId, undefined);
      await this.restoreOwnerAccountState(lease, accountId);
      finalizedAccountIds.push(accountId);
    }
    lease.accountIds = lease.accountIds.filter((accountId) => !finalizedAccountIds.includes(accountId));
    const previousState = lease.state;
    if (outcome === "failed") {
      lease.state = "failed";
      lease.returnedAt = this.now();
    } else if (lease.accountIds.length === 0) {
      lease.state = "returned";
      lease.returnedAt = this.now();
    } else {
      lease.state = "shared";
    }
    return finalizedAccountIds.length > 0 || previousState !== lease.state;
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
    await this.repo.setBalancePoolMembership(accountId, previous.balancePoolEnabled).catch(() => undefined);
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
    const privateState = getPrivateStatePaths(this.context);
    const storageDirectory = privateState.root;
    this.localStatePath = privateState.sharingState;
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
      getPrivateStatePaths(this.context).sharingHealth,
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

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error("账号共享功能已关闭，请先在 Manager 设置中重新开启");
    }
  }
}

function isActiveSharingLease(lease: SharingLease): boolean {
  return !["returned", "failed", "expired"].includes(lease.state);
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
    credentialSyncs: Array.isArray(value?.credentialSyncs) ? value.credentialSyncs.filter(isCredentialSyncRecord) : [],
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
    credentialSyncs: [],
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
    (request.state === "pending" ||
      request.state === "accepted" ||
      request.state === "rejected" ||
      request.state === "revoked") &&
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

function isCredentialSyncRecord(value: unknown): value is CredentialSyncRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const sync = value as Partial<CredentialSyncRecord>;
  return Boolean(
    typeof sync.syncId === "string" &&
    (sync.role === "primary" || sync.role === "follower") &&
    (sync.state === "pending" || sync.state === "active") &&
    typeof sync.peerUserId === "string" &&
    Array.isArray(sync.accountIds) &&
    sync.accountIds.every((id) => typeof id === "string") &&
    Number.isSafeInteger(sync.version) &&
    (sync.acknowledgedVersion === undefined || Number.isSafeInteger(sync.acknowledgedVersion)) &&
    typeof sync.createdAt === "number" &&
    (sync.pendingUpdate === undefined || isCredentialSyncPendingUpdate(sync.pendingUpdate))
  );
}

function isCredentialSyncPendingUpdate(value: unknown): value is CredentialSyncPendingUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const update = value as Partial<CredentialSyncPendingUpdate>;
  return Boolean(
    (update.initial === undefined || typeof update.initial === "boolean") &&
    Number.isSafeInteger(update.version) &&
    typeof update.eventId === "string" &&
    update.envelope &&
    typeof update.envelope === "object" &&
    typeof update.credentialFingerprint === "string" &&
    Number.isSafeInteger(update.attempts) &&
    (update.nextAttemptAt === undefined || typeof update.nextAttemptAt === "number")
  );
}

function withoutRefreshToken(account: SharedCodexAccountJson): SharedCodexAccountJson {
  return {
    id: account.id,
    email: account.email,
    auth_mode: "chatgpt",
    user_id: account.user_id,
    plan_type: account.plan_type,
    account_id: account.account_id,
    organization_id: account.organization_id,
    account_name: account.account_name,
    account_structure: account.account_structure,
    added_via: account.added_via,
    added_at: account.added_at,
    tokens: {
      id_token: account.tokens?.id_token,
      access_token: account.tokens?.access_token,
      account_id: account.tokens?.account_id ?? account.account_id
    }
  };
}

function credentialSnapshotFingerprint(accounts: readonly SharedCodexAccountJson[]): string {
  const snapshot = accounts
    .map((account) => [
      account.id ?? "",
      account.tokens?.id_token ?? "",
      account.tokens?.access_token ?? "",
      account.tokens?.refresh_token ?? "",
      account.tokens?.account_id ?? account.account_id ?? ""
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function validateCredentialSyncPackage(
  value: CredentialSyncPackage,
  expectedSyncId: string,
  expectedVersion: number,
  expectedEventId: string
): void {
  if (
    value?.schema !== CREDENTIAL_SYNC_PACKAGE_SCHEMA ||
    value.syncId !== expectedSyncId ||
    value.version !== expectedVersion ||
    value.eventId !== expectedEventId ||
    !Array.isArray(value.accounts) ||
    value.accounts.length === 0 ||
    value.accounts.length > MAX_SHARED_ACCOUNTS
  ) {
    throw new Error("credential sync package is invalid");
  }
  for (const account of value.accounts) {
    if (!account.tokens?.id_token || !account.tokens.access_token || account.tokens.refresh_token !== undefined) {
      throw new Error("credential sync package must contain access credentials only");
    }
  }
}

function isAccountUsagePackageEntry(value: unknown): value is AccountUsagePackage["accounts"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<AccountUsagePackage["accounts"][number]>;
  return (
    typeof entry.accountId === "string" &&
    entry.accountId.trim().length > 0 &&
    (entry.tokenUsage === undefined || isAccountUsageWindow(entry.tokenUsage)) &&
    (entry.lifetimeTokenUsage === undefined || isAccountUsageLifetime(entry.lifetimeTokenUsage))
  );
}

function isAccountUsageWindow(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const usage = value as Partial<NonNullable<AccountUsagePackage["accounts"][number]["tokenUsage"]>>;
  return Boolean(
    (usage.status === "loading" || usage.status === "tracking" || usage.status === "waiting") &&
    (usage.window === "hourly" || usage.window === "weekly") &&
    typeof usage.resetAt === "number" &&
    Number.isFinite(usage.resetAt) &&
    Array.isArray(usage.byModel) &&
    usage.byModel.every(isUsageModel) &&
    isUsageTotals(usage)
  );
}

function isAccountUsageLifetime(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const usage = value as Partial<NonNullable<AccountUsagePackage["accounts"][number]["lifetimeTokenUsage"]>>;
  return Boolean(
    typeof usage.windowCount === "number" &&
    Number.isSafeInteger(usage.windowCount) &&
    usage.windowCount >= 0 &&
    Array.isArray(usage.byModel) &&
    usage.byModel.every(isUsageModel) &&
    isUsageTotals(usage)
  );
}

function isUsageModel(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const model = value as Partial<{
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }>;
  return typeof model.model === "string" && model.model.length > 0 && isUsageTotals(model);
}

function isUsageTotals(
  value: Partial<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }>
): boolean {
  return [
    value.inputTokens,
    value.cachedInputTokens,
    value.outputTokens,
    value.reasoningOutputTokens,
    value.totalTokens
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
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
