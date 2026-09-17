import { useEffect, useState } from "preact/hooks";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardSharingViewModel
} from "../../src/domain/dashboard/types";
import type { DashboardLanguage } from "../../src/localization/languages";
import { ModalShell } from "./primitives";

type SharingAction = (
  action: DashboardActionName,
  accountId?: string,
  payload?: DashboardActionPayload
) => void;

export function SharingModal(props: {
  open: boolean;
  lang: DashboardLanguage;
  sharing?: DashboardSharingViewModel;
  accountIds: readonly string[];
  pending: boolean;
  onClose: () => void;
  onAction: SharingAction;
}) {
  const [peerId, setPeerId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sharePeerId, setSharePeerId] = useState("");
  const [shareDeadlineMs, setShareDeadlineMs] = useState(24 * 60 * 60 * 1_000);
  const zh = props.lang === "zh";
  const hant = props.lang === "zh-hant";
  const localized = (simplified: string, traditional: string, english: string): string =>
    zh ? simplified : hant ? traditional : english;

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const peer of props.sharing?.peers ?? []) {
      next[peer.userId] = peer.note ?? "";
    }
    setNotes(next);
  }, [props.sharing?.peers]);

  useEffect(() => {
    const trustedPeers = (props.sharing?.peers ?? []).filter((peer) => peer.relationship === "trusted");
    if (!trustedPeers.some((peer) => peer.userId === sharePeerId)) {
      setSharePeerId(trustedPeers[0]?.userId ?? "");
    }
  }, [props.sharing?.peers, sharePeerId]);

  const submitPeer = (event: Event): void => {
    event.preventDefault();
    const normalized = peerId.trim();
    if (!normalized) {
      return;
    }
    props.onAction("manageSharing", undefined, {
      sharingOperation: "addPeer",
      sharingUserId: normalized
    });
    setPeerId("");
  };

  const submitShare = (): void => {
    if (!sharePeerId || props.accountIds.length === 0) {
      return;
    }
    props.onAction("shareAccounts", undefined, {
      accountIds: [...props.accountIds],
      sharingPeerUserId: sharePeerId,
      sharingDeadlineMs: shareDeadlineMs
    });
    props.onClose();
  };

  return (
    <ModalShell
      open={props.open}
      title={localized("账号共享", "帳號共享", "Account sharing")}
      closeLabel={localized("关闭", "關閉", "Close")}
      className="sharing-modal"
      onClose={props.onClose}
    >
      {!props.sharing ? (
        <div class="modal-note">{localized("共享服务尚未启动。", "共享服務尚未啟動。", "Sharing is not ready yet.")}</div>
      ) : (
        <div class="sharing-modal-stack">
          <section class="sharing-panel-section sharing-identity-section">
            <div class="sharing-section-title">{localized("我的共享 ID", "我的共享 ID", "My sharing ID")}</div>
            <div class="sharing-id-row">
              <code>{props.sharing.userId}</code>
              <button
                class="modal-secondary-btn"
                type="button"
                disabled={props.pending}
                onClick={() => props.onAction("copyText", undefined, { text: props.sharing?.userId ?? "" })}
              >
                {localized("复制", "複製", "Copy")}
              </button>
            </div>
            <div class="modal-note">
              {props.sharing.relayConfigured
                ? localized("已连接共享 Relay。", "已連線共享 Relay。", "Sharing Relay is connected.")
                : localized("尚未配置共享 Relay。", "尚未配置共享 Relay。", "Sharing Relay is not configured.")}
            </div>
            <div class={`sharing-sync-status ${props.sharing.lastSyncError ? "has-error" : ""}`}>
              {props.sharing.lastSyncError
                ? `${localized("同步失败", "同步失敗", "Sync failed")}: ${props.sharing.lastSyncError}`
                : props.sharing.lastSyncAt
                  ? `${localized("最近同步", "最近同步", "Last sync")}: ${new Date(props.sharing.lastSyncAt).toLocaleTimeString()}`
                  : localized("尚未完成同步。", "尚未完成同步。", "No sync completed yet.")}
            </div>
            <div class="sharing-inline-actions">
              <button
                class="modal-secondary-btn"
                type="button"
                disabled={props.pending}
                onClick={() => props.onAction("manageSharing", undefined, { sharingOperation: "sync" })}
              >
                {localized("立即同步", "立即同步", "Sync now")}
              </button>
              <button
                class="modal-secondary-btn"
                type="button"
                disabled={props.pending}
                onClick={() => props.onAction("manageSharing", undefined, { sharingOperation: "configureRelay" })}
              >
                {localized("配置 Relay", "配置 Relay", "Configure Relay")}
              </button>
              <button
                class="modal-secondary-btn sharing-danger-text"
                type="button"
                disabled={props.pending}
                onClick={() => props.onAction("manageSharing", undefined, { sharingOperation: "resetIdentity" })}
              >
                {localized("重新生成 ID", "重新產生 ID", "Regenerate ID")}
              </button>
            </div>
          </section>

          {props.accountIds.length > 0 ? (
            <section class="sharing-panel-section sharing-start-section">
              <div class="sharing-section-title">
                {localized("共享所选账号", "共享所選帳號", "Share selected accounts")}
              </div>
              <div class="modal-note">
                {localized(
                  `当前选择 ${props.accountIds.length} 个账号。共享会立即移出本机无感池，接收端完成归还确认后再恢复。`,
                  `目前選擇 ${props.accountIds.length} 個帳號。共享會立即移出本機無感池，接收端完成歸還確認後再恢復。`,
                  `${props.accountIds.length} account(s) selected. They leave this host's seamless pool until the return is confirmed.`
                )}
              </div>
              <div class="sharing-share-form">
                <label class="sharing-form-field">
                  <span>{localized("共享给", "共享給", "Share with")}</span>
                  <select
                    class="modal-input"
                    value={sharePeerId}
                    onChange={(event) => setSharePeerId(event.currentTarget.value)}
                  >
                    {(props.sharing.peers ?? [])
                      .filter((peer) => peer.relationship === "trusted")
                      .map((peer) => (
                        <option key={peer.userId} value={peer.userId}>
                          {peer.note?.trim() || peer.displayName} · {peer.userId}
                        </option>
                      ))}
                  </select>
                </label>
                <label class="sharing-form-field">
                  <span>{localized("归还期限", "歸還期限", "Return deadline")}</span>
                  <select
                    class="modal-input"
                    value={String(shareDeadlineMs)}
                    onChange={(event) => setShareDeadlineMs(Number(event.currentTarget.value))}
                  >
                    <option value={String(10 * 60 * 1_000)}>{localized("10 分钟", "10 分鐘", "10 minutes")}</option>
                    <option value={String(30 * 60 * 1_000)}>{localized("30 分钟", "30 分鐘", "30 minutes")}</option>
                    <option value={String(60 * 60 * 1_000)}>{localized("1 小时", "1 小時", "1 hour")}</option>
                    <option value={String(6 * 60 * 60 * 1_000)}>{localized("6 小时", "6 小時", "6 hours")}</option>
                    <option value={String(24 * 60 * 60 * 1_000)}>{localized("24 小时", "24 小時", "24 hours")}</option>
                    <option value={String(3 * 24 * 60 * 60 * 1_000)}>{localized("3 天", "3 天", "3 days")}</option>
                  </select>
                </label>
              </div>
              <button
                class="modal-primary-btn"
                type="button"
                disabled={!sharePeerId || props.pending}
                onClick={submitShare}
              >
                {localized("开始共享", "開始共享", "Start sharing")}
              </button>
            </section>
          ) : null}

          <section class="sharing-panel-section">
            <div class="sharing-section-title">{localized("添加好友", "新增好友", "Add a friend")}</div>
            <form class="sharing-add-form" onSubmit={submitPeer}>
              <input
                class="modal-input"
                type="text"
                value={peerId}
                placeholder={localized("输入对方共享 ID", "輸入對方共享 ID", "Enter the other user's sharing ID")}
                onInput={(event) => setPeerId(event.currentTarget.value)}
              />
              <button class="modal-primary-btn" type="submit" disabled={!peerId.trim() || props.pending}>
                {localized("发送请求", "傳送請求", "Send request")}
              </button>
            </form>
            <div class="modal-note">
              {localized(
                "只有对方接受请求后，你主动勾选并共享的账号才会发送；其他人不能操作你的账号。",
                "只有對方接受請求後，你主動勾選並共享的帳號才會傳送；其他人不能操作你的帳號。",
                "Only accounts you explicitly select and share after the peer accepts can be sent; nobody else can operate your accounts."
              )}
            </div>
          </section>

          {props.sharing.pendingRequests.length > 0 ? (
            <section class="sharing-panel-section">
              <div class="sharing-section-title">
                {localized("待处理请求", "待處理請求", "Pending requests")} ({props.sharing.pendingRequests.length})
              </div>
              <div class="sharing-request-list">
                {props.sharing.pendingRequests.map((request) => (
                  <div class="sharing-request-row" key={request.id}>
                    <div class="sharing-peer-copy">
                      <strong>{request.fromDisplayName}</strong>
                      <code>{request.fromUserId}</code>
                    </div>
                    <div class="sharing-inline-actions">
                      <button
                        class="modal-primary-btn"
                        type="button"
                        disabled={props.pending}
                        onClick={() =>
                          props.onAction("manageSharing", undefined, {
                            sharingOperation: "acceptRequest",
                            sharingRequestId: request.id
                          })
                        }
                      >
                        {localized("接受", "接受", "Accept")}
                      </button>
                      <button
                        class="modal-secondary-btn"
                        type="button"
                        disabled={props.pending}
                        onClick={() =>
                          props.onAction("manageSharing", undefined, {
                            sharingOperation: "rejectRequest",
                            sharingRequestId: request.id
                          })
                        }
                      >
                        {localized("拒绝", "拒絕", "Reject")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section class="sharing-panel-section">
            <div class="sharing-section-title">{localized("好友备注", "好友備註", "Friend notes")}</div>
            {props.sharing.peers.length === 0 ? (
              <div class="modal-note">{localized("还没有好友。", "還沒有好友。", "No friends yet.")}</div>
            ) : (
              <div class="sharing-peer-list">
                {props.sharing.peers.map((peer) => (
                  <div class="sharing-peer-row" key={peer.userId}>
                    <div class="sharing-peer-copy">
                      <strong>{peer.displayName}</strong>
                      <code>{peer.userId}</code>
                      {peer.relationship === "pending_outgoing" ? (
                        <span class="sharing-peer-state">{localized("等待接受", "等待接受", "Awaiting acceptance")}</span>
                      ) : null}
                    </div>
                    <div class="sharing-note-row">
                      <input
                        class="modal-input"
                        type="text"
                        value={notes[peer.userId] ?? ""}
                        placeholder={localized("备注名（仅本机）", "備註名（僅本機）", "Local note")}
                        onInput={(event) =>
                          setNotes((current) => ({ ...current, [peer.userId]: event.currentTarget.value }))
                        }
                      />
                      <button
                        class="modal-secondary-btn"
                        type="button"
                        disabled={props.pending}
                        onClick={() =>
                          props.onAction("manageSharing", undefined, {
                            sharingOperation: "setPeerNote",
                            sharingUserId: peer.userId,
                            sharingNote: notes[peer.userId] ?? ""
                          })
                        }
                      >
                        {localized("保存", "儲存", "Save")}
                      </button>
                      <button
                        class="modal-secondary-btn sharing-danger-text"
                        type="button"
                        disabled={props.pending}
                        onClick={() =>
                          props.onAction("manageSharing", undefined, {
                            sharingOperation: "removePeer",
                            sharingUserId: peer.userId
                          })
                        }
                      >
                        {localized("删除好友", "刪除好友", "Remove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </ModalShell>
  );
}
