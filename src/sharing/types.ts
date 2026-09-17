import type { CodexAccountSharingInfo, SharedCodexAccountJson } from "../core/types";
import type { SharingEnvelope, SharingKeyMaterial } from "./crypto";

export const SHARING_PACKAGE_SCHEMA = "codex-account-sharing-package/v1";
export const SHARING_RETURN_PACKAGE_SCHEMA = "codex-account-sharing-return/v1";

export type SharingPublicProfile = {
  userId: string;
  displayName: string;
  identityPublicKey: string;
  encryptionPublicKey: string;
  createdAt?: number;
  updatedAt?: number;
};

export type SharingPeer = SharingPublicProfile & {
  relationship: "pending_outgoing" | "trusted";
  addedAt: number;
  requestId?: string;
  /** A local-only nickname/remark; never sent to the peer. */
  note?: string;
};

export type SharingRequest = {
  id: string;
  fromUserId: string;
  toUserId: string;
  state: "pending" | "accepted" | "rejected" | "revoked";
  createdAt: number;
  updatedAt: number;
  fromProfile?: SharingPublicProfile;
};

export type SharingLease = {
  leaseId: string;
  transferId: string;
  direction: "outgoing" | "incoming";
  state: "shared" | "received" | "return_pending" | "returned" | "expired" | "failed";
  peerUserId: string;
  peerDisplayName?: string;
  accountIds: string[];
  expiresAt: number;
  createdAt: number;
  returnedAt?: number;
  returnReason?: "manual" | "expired" | "quota_exhausted";
  /** The sender-side confirmation deadline for the initial hand-off. */
  handshakeDeadlineAt?: number;
  /** Owner-local presentation/pool state captured before the account was hidden for sharing. */
  ownerAccountStates?: Array<{
    accountId: string;
    isHidden: boolean;
    balancePoolEnabled: boolean;
  }>;
  /** Account IDs whose owner-side credential write still needs relay ack. */
  returnAckAccountIds?: string[];
};

export type SharingState = {
  version: 1;
  profile: {
    userId: string;
    displayName: string;
    identityPublicKey: string;
    encryptionPublicKey: string;
  };
  peers: SharingPeer[];
  pendingRequests: SharingRequest[];
  leases: SharingLease[];
  processedTransferIds: string[];
};

export type SharingPackage = {
  schema: typeof SHARING_PACKAGE_SCHEMA;
  leaseId: string;
  expiresAt: number;
  accounts: SharedCodexAccountJson[];
};

export type SharingReturnPackage = {
  schema: typeof SHARING_RETURN_PACKAGE_SCHEMA;
  leaseId: string;
  transferId: string;
  accounts: SharedCodexAccountJson[];
};

export type SharingReturnEnvelope = {
  accountIds: string[];
  envelope: SharingEnvelope;
};

export type SharingTransfer = {
  id: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: number;
  envelope: SharingEnvelope;
  state: "pending" | "delivered" | "failed" | "returned" | "cancelled";
  /** Account IDs that the recipient returned early from a multi-account lease. */
  returnedAccountIds?: string[];
  /** Encrypted latest-credential packages waiting for the owner to apply. */
  returnEnvelopes?: SharingReturnEnvelope[];
  /** Account IDs that the owner has confirmed writing back. */
  ownerConfirmedAccountIds?: string[];
  result?: {
    status: "completed" | "partial" | "failed";
    imported: number;
    poolEnabled: number;
    message?: string;
  };
  createdAt: number;
  updatedAt: number;
};

export type SharingRuntime = {
  keys: SharingKeyMaterial;
  state: SharingState;
  relayToken?: string;
};

export function sharingInfoForLease(
  lease: SharingLease,
  state: Extract<SharingLease["state"], "shared" | "received" | "return_pending">
): CodexAccountSharingInfo {
  return {
    leaseId: lease.leaseId,
    transferId: lease.transferId,
    direction: lease.direction,
    state,
    peerUserId: lease.peerUserId,
    peerDisplayName: lease.peerDisplayName,
    expiresAt: lease.expiresAt,
    sharedAt: lease.createdAt
  };
}
