import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;
const USER_ID_PATTERN = /^rw_[A-Za-z0-9_-]{16,64}$/u;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS_PER_USER = 256;
const MAX_TRANSFERS_PER_USER = 256;
const MAX_RETURN_ENVELOPES = 50;
const MAX_USAGE_REQUESTS_PER_USER = 64;
const MAX_USAGE_UPDATES_PER_USER = 64;
const USAGE_REQUEST_TTL_MS = 60 * 1000;
const MAX_USAGE_ENVELOPE_BYTES = 512 * 1024;
const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/u;

/**
 * Small persistence-backed rendezvous service for Manager account sharing.
 * It stores public profiles and encrypted transfer envelopes only. OAuth
 * tokens are never decrypted or inspected here.
 */
export function createSharingRelay({ stateDir, bootstrapToken, now = () => Date.now() } = {}) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new Error("sharing relay stateDir is required");
  }
  const normalizedBootstrapToken = normalizeSecret(bootstrapToken);
  if (!normalizedBootstrapToken) {
    throw new Error("sharing relay bootstrapToken is required");
  }

  const filePath = path.join(stateDir, "sharing-relay-v1.json");
  let state = emptyState();
  let initialized = false;
  let writeQueue = Promise.resolve();

  return {
    async init() {
      if (initialized) {
        return;
      }
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      try {
        const raw = await readFile(filePath, "utf8");
        state = parseState(JSON.parse(raw));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new Error(`sharing relay state is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      initialized = true;
    },

    isBootstrapToken(token) {
      return secretsEqual(normalizedBootstrapToken, token);
    },

    async registerProfile(profile, token) {
      assertBootstrapToken(token);
      const normalized = normalizeProfile(profile);
      const existing = state.users[normalized.userId];
      if (existing && (existing.identityPublicKey !== normalized.identityPublicKey || existing.encryptionPublicKey !== normalized.encryptionPublicKey)) {
        throw httpError(409, "user ID is already bound to another identity");
      }
      const mailboxToken = randomBytes(32).toString("base64url");
      state.users[normalized.userId] = {
        ...normalized,
        mailboxTokenHash: hashSecret(mailboxToken),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now()
      };
      await persist();
      return { profile: publicProfile(state.users[normalized.userId]), mailboxToken };
    },

    async authenticate(token) {
      await ensureInitialized();
      if (!normalizeSecret(token)) {
        return undefined;
      }
      for (const user of Object.values(state.users)) {
        if (secretsEqual(user.mailboxTokenHash, hashSecret(token))) {
          user.updatedAt = now();
          return publicProfile(user);
        }
      }
      return undefined;
    },

    async lookupUser(userId, token) {
      await ensureInitialized();
      assertAuthenticated(token);
      const user = state.users[normalizeUserId(userId)];
      return user ? publicProfile(user) : undefined;
    },

    async createRequest(fromUserId, toUserId, token) {
      await ensureInitialized();
      assertUserToken(fromUserId, token);
      const target = requireUser(toUserId);
      if (target.userId === fromUserId) {
        throw httpError(400, "a user cannot add itself");
      }
      const duplicate = state.requests.find(
        (request) =>
          request.fromUserId === fromUserId &&
          request.toUserId === target.userId &&
          request.state === "pending"
      );
      if (duplicate) {
        return publicRequest(duplicate);
      }
      const request = {
        id: randomUUID(),
        fromUserId,
        toUserId: target.userId,
        state: "pending",
        createdAt: now(),
        updatedAt: now()
      };
      state.requests.push(request);
      pruneState();
      await persist();
      return publicRequest(request);
    },

    async listIncomingRequests(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      return state.requests
        .filter((request) => request.toUserId === userId && request.state === "pending")
        .map(publicRequest);
    },

    async updateRequest(requestId, userId, accepted, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const request = state.requests.find((candidate) => candidate.id === requestId);
      if (!request || request.toUserId !== userId) {
        throw httpError(404, "sharing request not found");
      }
      if (request.state !== "pending") {
        return publicRequest(request);
      }
      request.state = accepted ? "accepted" : "rejected";
      request.updatedAt = now();
      await persist();
      return publicRequest(request);
    },

    async removePeer(userId, peerUserId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const normalizedPeerUserId = normalizeUserId(peerUserId);
      requireUser(normalizedPeerUserId);
      const related = state.requests.filter(
        (request) =>
          (request.fromUserId === userId && request.toUserId === normalizedPeerUserId) ||
          (request.fromUserId === normalizedPeerUserId && request.toUserId === userId)
      );
      if (related.length === 0) {
        return { removed: false, peerUserId: normalizedPeerUserId };
      }
      const updatedAt = now();
      for (const request of related) {
        request.state = "revoked";
        request.updatedAt = updatedAt;
      }
      for (const sync of state.credentialSyncs) {
        if (
          sync.state === "active" &&
          ((sync.fromUserId === userId && sync.toUserId === normalizedPeerUserId) ||
            (sync.fromUserId === normalizedPeerUserId && sync.toUserId === userId))
        ) {
          sync.state = "stopped";
          sync.stoppedBy = userId;
          sync.stopAcknowledgedBy = [userId];
          sync.updatedAt = updatedAt;
        }
      }
      state.usageRequests = state.usageRequests.filter(
        (usageRequest) =>
          !(
            (usageRequest.fromUserId === userId && usageRequest.toUserId === normalizedPeerUserId) ||
            (usageRequest.fromUserId === normalizedPeerUserId && usageRequest.toUserId === userId)
          )
      );
      state.usageUpdates = state.usageUpdates.filter(
        (usageUpdate) =>
          !(
            (usageUpdate.fromUserId === userId && usageUpdate.toUserId === normalizedPeerUserId) ||
            (usageUpdate.fromUserId === normalizedPeerUserId && usageUpdate.toUserId === userId)
          )
      );
      await persist();
      return { removed: true, peerUserId: normalizedPeerUserId };
    },

    async listRequestsForUser(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      return state.requests
        .filter((request) => request.fromUserId === userId || request.toUserId === userId)
        .map(publicRequest);
    },

    async createTransfer(fromUserId, payload, token) {
      await ensureInitialized();
      assertUserToken(fromUserId, token);
      await expirePendingTransfers();
      const recipientUserId = normalizeUserId(payload?.recipientUserId);
      requireUser(recipientUserId);
      const expiresAt = Number(payload?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        throw httpError(400, "sharing lease expiration must be in the future");
      }
      const envelope = payload?.envelope;
      const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope ?? null), "utf8");
      if (!envelope || typeof envelope !== "object" || envelopeBytes > MAX_ENVELOPE_BYTES) {
        throw httpError(400, "encrypted sharing envelope is invalid or too large");
      }
      const transfer = {
        id: randomUUID(),
        fromUserId,
        toUserId: recipientUserId,
        expiresAt,
        envelope,
        state: "pending",
        createdAt: now(),
        updatedAt: now()
      };
      state.transfers.push(transfer);
      pruneState();
      await persist();
      return publicTransfer(transfer);
    },

    async createCredentialSync(fromUserId, payload, token) {
      await ensureInitialized();
      assertUserToken(fromUserId, token);
      const syncId = normalizeSyncId(payload?.syncId);
      const recipientUserId = normalizeUserId(payload?.recipientUserId);
      requireTrustedPeer(fromUserId, recipientUserId);
      const duplicate = state.credentialSyncs.find((sync) => sync.syncId === syncId);
      if (duplicate) {
        if (duplicate.fromUserId !== fromUserId || duplicate.toUserId !== recipientUserId) {
          throw httpError(409, "credential sync ID is already in use");
        }
        if (
          duplicate.version !== Number(payload?.version) ||
          duplicate.eventId !== normalizeEventId(payload?.eventId) ||
          JSON.stringify(duplicate.envelope) !== JSON.stringify(normalizeCredentialEnvelope(payload?.envelope))
        ) {
          throw httpError(409, "credential sync creation is not idempotent");
        }
        return publicCredentialSync(duplicate);
      }
      const version = Number(payload?.version);
      const eventId = normalizeEventId(payload?.eventId);
      const envelope = normalizeCredentialEnvelope(payload?.envelope);
      if (version !== 1) {
        throw httpError(400, "initial credential sync version must be 1");
      }
      const sync = {
        syncId,
        fromUserId,
        toUserId: recipientUserId,
        version,
        eventId,
        envelope,
        state: "active",
        acknowledgedVersion: 0,
        createdAt: now(),
        updatedAt: now()
      };
      state.credentialSyncs.push(sync);
      await persist();
      return publicCredentialSync(sync);
    },

    async listIncomingCredentialSyncs(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      return state.credentialSyncs
        .filter(
          (sync) =>
            sync.toUserId === userId &&
            (sync.state === "active" || !(sync.stopAcknowledgedBy ?? []).includes(userId))
        )
        .map(publicCredentialSync);
    },

    async listSentCredentialSyncs(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      return state.credentialSyncs
        .filter(
          (sync) =>
            sync.fromUserId === userId &&
            (sync.state === "active" || !(sync.stopAcknowledgedBy ?? []).includes(userId))
        )
        .map(publicCredentialSync);
    },

    async createUsageReadRequests(fromUserId, payload, token) {
      await ensureInitialized();
      assertUserToken(fromUserId, token);
      await expireUsageReadRequests();
      const syncIds = normalizeSyncIds(payload?.syncIds);
      const requests = [];
      for (const syncId of syncIds) {
        const sync = requireActiveCredentialSync(syncId, fromUserId);
        const duplicate = state.usageRequests.find(
          (request) =>
            request.syncId === syncId &&
            request.fromUserId === fromUserId &&
            request.state === "pending" &&
            request.expiresAt > now()
        );
        if (duplicate) {
          requests.push(publicUsageReadRequest(duplicate));
          continue;
        }
        const request = {
          id: randomUUID(),
          syncId,
          fromUserId,
          toUserId: sync.toUserId,
          state: "pending",
          createdAt: now(),
          expiresAt: now() + USAGE_REQUEST_TTL_MS
        };
        state.usageRequests.push(request);
        requests.push(publicUsageReadRequest(request));
      }
      pruneUsageReadRequests();
      await persist();
      return requests;
    },

    async listIncomingUsageReadRequests(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expireUsageReadRequests();
      return state.usageRequests
        .filter((request) => request.toUserId === userId && request.state === "pending")
        .map(publicUsageReadRequest);
    },

    async listSentUsageReadRequests(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expireUsageReadRequests();
      return state.usageRequests
        .filter((request) => request.fromUserId === userId)
        .map(publicUsageReadRequest);
    },

    async publishUsageUpdate(userId, payload, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const syncId = normalizeSyncId(payload?.syncId);
      const sync = requireActiveCredentialSyncForFollower(syncId, userId);
      const revision = Number(payload?.revision);
      const eventId = normalizeEventId(payload?.eventId);
      const envelope = normalizeUsageEnvelope(payload?.envelope);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw httpError(400, "account usage update revision is invalid");
      }
      const existing = state.usageUpdates.find((candidate) => candidate.syncId === syncId);
      if (existing && existing.revision >= revision) {
        return publicUsageUpdate(existing);
      }
      const update = {
        syncId,
        fromUserId: userId,
        toUserId: sync.fromUserId,
        revision,
        eventId,
        envelope,
        updatedAt: now()
      };
      state.usageUpdates = state.usageUpdates.filter((candidate) => candidate.syncId !== syncId);
      state.usageUpdates.push(update);
      pruneUsageUpdates();
      await persist();
      return publicUsageUpdate(update);
    },

    async listIncomingUsageUpdates(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      return state.usageUpdates.filter((update) => update.toUserId === userId).map(publicUsageUpdate);
    },

    async acknowledgeUsageUpdate(syncId, revision, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const normalizedSyncId = normalizeSyncId(syncId);
      const normalizedRevision = Number(revision);
      if (!Number.isSafeInteger(normalizedRevision) || normalizedRevision < 0) {
        throw httpError(400, "account usage update acknowledgement revision is invalid");
      }
      const index = state.usageUpdates.findIndex(
        (update) =>
          update.syncId === normalizedSyncId &&
          update.toUserId === userId &&
          update.revision <= normalizedRevision
      );
      if (index >= 0) {
        state.usageUpdates.splice(index, 1);
        await persist();
      }
      return { acknowledged: true, syncId: normalizedSyncId, revision: normalizedRevision };
    },

    async respondToUsageReadRequest(requestId, userId, payload, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expireUsageReadRequests();
      const request = state.usageRequests.find((candidate) => candidate.id === requestId);
      if (!request || request.toUserId !== userId) {
        throw httpError(404, "usage read request not found");
      }
      const revision = Number(payload?.revision);
      const eventId = normalizeEventId(payload?.eventId);
      const envelope = normalizeUsageEnvelope(payload?.envelope);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw httpError(400, "usage read revision is invalid");
      }
      if (request.state === "responded") {
        if (
          request.response?.revision !== revision ||
          request.response?.eventId !== eventId ||
          JSON.stringify(request.response.envelope) !== JSON.stringify(envelope)
        ) {
          throw httpError(409, "usage read response is not idempotent");
        }
        return publicUsageReadRequest(request);
      }
      request.state = "responded";
      request.response = { revision, eventId, envelope, updatedAt: now() };
      await persist();
      return publicUsageReadRequest(request);
    },

    async acknowledgeUsageReadRequest(requestId, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const index = state.usageRequests.findIndex(
        (candidate) => candidate.id === requestId && candidate.fromUserId === userId
      );
      if (index < 0) {
        throw httpError(404, "usage read request not found");
      }
      state.usageRequests.splice(index, 1);
      await persist();
      return { acknowledged: true, requestId };
    },

    async getCredentialSync(syncId, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const sync = state.credentialSyncs.find((candidate) => candidate.syncId === normalizeSyncId(syncId));
      if (!sync || (sync.fromUserId !== userId && sync.toUserId !== userId)) {
        throw httpError(404, "credential sync not found");
      }
      return publicCredentialSync(sync);
    },

    async updateCredentialSync(syncId, userId, payload, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const sync = state.credentialSyncs.find((candidate) => candidate.syncId === normalizeSyncId(syncId));
      if (!sync || sync.fromUserId !== userId) {
        throw httpError(404, "credential sync not found");
      }
      if (sync.state !== "active") {
        throw httpError(409, "credential sync is stopped");
      }
      const version = Number(payload?.version);
      const eventId = normalizeEventId(payload?.eventId);
      const envelope = normalizeCredentialEnvelope(payload?.envelope);
      if (version === sync.version && eventId === sync.eventId) {
        if (JSON.stringify(envelope) !== JSON.stringify(sync.envelope)) {
          throw httpError(409, "credential sync event ID was reused with different content");
        }
        return publicCredentialSync(sync);
      }
      if (!Number.isSafeInteger(version) || version <= sync.version) {
        throw httpError(409, "credential sync version is stale");
      }
      sync.version = version;
      sync.eventId = eventId;
      sync.envelope = envelope;
      sync.updatedAt = now();
      await persist();
      return publicCredentialSync(sync);
    },

    async acknowledgeCredentialSync(syncId, userId, payload, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const sync = state.credentialSyncs.find((candidate) => candidate.syncId === normalizeSyncId(syncId));
      if (!sync || (sync.toUserId !== userId && sync.fromUserId !== userId)) {
        throw httpError(404, "credential sync not found");
      }
      if (userId === sync.toUserId) {
        const version = Number(payload?.version);
        if (!Number.isSafeInteger(version) || version < 0 || version > sync.version) {
          throw httpError(400, "credential sync acknowledgement version is invalid");
        }
        sync.acknowledgedVersion = Math.max(sync.acknowledgedVersion, version);
      } else if (sync.state !== "stopped") {
        throw httpError(403, "only the recipient can acknowledge an active credential snapshot");
      }
      if (sync.state === "stopped") {
        sync.stopAcknowledgedBy = Array.from(new Set([...(sync.stopAcknowledgedBy ?? []), userId]));
        pruneStoppedCredentialSyncs();
      }
      sync.updatedAt = now();
      await persist();
      return publicCredentialSync(sync);
    },

    async stopCredentialSync(syncId, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const sync = state.credentialSyncs.find((candidate) => candidate.syncId === normalizeSyncId(syncId));
      if (!sync || (sync.fromUserId !== userId && sync.toUserId !== userId)) {
        throw httpError(404, "credential sync not found");
      }
      if (sync.state !== "stopped") {
        sync.state = "stopped";
        sync.stoppedBy = userId;
        sync.stopAcknowledgedBy = [userId];
        sync.updatedAt = now();
        state.usageRequests = state.usageRequests.filter((request) => request.syncId !== sync.syncId);
        state.usageUpdates = state.usageUpdates.filter((update) => update.syncId !== sync.syncId);
        await persist();
      }
      return publicCredentialSync(sync);
    },

    async listIncomingTransfers(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expirePendingTransfers();
      return state.transfers
        .filter((transfer) => transfer.toUserId === userId && transfer.state === "pending")
        .map(publicTransfer);
    },

    async listSentTransfers(userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expirePendingTransfers();
      return state.transfers
        .filter((transfer) => transfer.fromUserId === userId)
        .map(publicTransfer);
    },

    async getTransferForRecipient(transferId, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      await expirePendingTransfers();
      const transfer = state.transfers.find((candidate) => candidate.id === transferId);
      if (!transfer || transfer.toUserId !== userId) {
        throw httpError(404, "sharing transfer not found");
      }
      return publicTransfer(transfer);
    },

    async acknowledgeTransfer(transferId, userId, result, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const transfer = state.transfers.find((candidate) => candidate.id === transferId);
      if (!transfer || transfer.toUserId !== userId) {
        throw httpError(404, "sharing transfer not found");
      }
      if (transfer.state === "pending") {
        transfer.state = result?.status === "failed" ? "failed" : "delivered";
        transfer.result = normalizeTransferResult(result);
        transfer.updatedAt = now();
        await persist();
      }
      return publicTransfer(transfer);
    },

    async returnTransfer(transferId, userId, payload, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const transfer = state.transfers.find((candidate) => candidate.id === transferId);
      if (!transfer || transfer.toUserId !== userId) {
        throw httpError(404, "sharing transfer not found");
      }
      const normalizedAccountIds = normalizeAccountIds(payload?.accountIds);
      const complete = payload?.complete === true || normalizedAccountIds.length === 0;
      const returnEnvelope = normalizeReturnEnvelope(payload?.returnEnvelope, normalizedAccountIds);
      if (returnEnvelope) {
        transfer.returnEnvelopes = [...(transfer.returnEnvelopes ?? []), returnEnvelope].slice(-MAX_RETURN_ENVELOPES);
      }
      if (!complete && transfer.state === "delivered") {
        transfer.returnedAccountIds = Array.from(
          new Set([...(transfer.returnedAccountIds ?? []), ...normalizedAccountIds])
        ).slice(0, 50);
        transfer.updatedAt = now();
        await persist();
      } else if (complete && (transfer.state === "delivered" || transfer.state === "pending")) {
        if (normalizedAccountIds.length > 0) {
          transfer.returnedAccountIds = Array.from(
            new Set([...(transfer.returnedAccountIds ?? []), ...normalizedAccountIds])
          ).slice(0, 50);
        }
        transfer.state = "returned";
        transfer.updatedAt = now();
        await persist();
      }
      return publicTransfer(transfer);
    },

    async confirmReturn(transferId, userId, accountIds, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const transfer = state.transfers.find((candidate) => candidate.id === transferId);
      if (!transfer || transfer.fromUserId !== userId) {
        throw httpError(404, "sharing transfer not found");
      }
      const normalizedAccountIds = normalizeAccountIds(accountIds);
      if (normalizedAccountIds.length === 0) {
        return publicTransfer(transfer);
      }
      transfer.ownerConfirmedAccountIds = Array.from(
        new Set([...(transfer.ownerConfirmedAccountIds ?? []), ...normalizedAccountIds])
      ).slice(0, 50);
      transfer.updatedAt = now();
      await persist();
      return publicTransfer(transfer);
    },

    async cancelTransfer(transferId, userId, token) {
      await ensureInitialized();
      assertUserToken(userId, token);
      const transfer = state.transfers.find((candidate) => candidate.id === transferId);
      if (!transfer || transfer.fromUserId !== userId) {
        throw httpError(404, "sharing transfer not found");
      }
      if (transfer.state === "pending") {
        transfer.state = "cancelled";
        transfer.result = normalizeTransferResult({
          status: "failed",
          imported: 0,
          poolEnabled: 0,
          message: "sharing handshake timed out"
        });
        transfer.updatedAt = now();
        await persist();
      }
      return publicTransfer(transfer);
    },

    async persist() {
      await persist();
    }
  };

  async function ensureInitialized() {
    if (!initialized) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      initialized = true;
    }
  }

  async function expirePendingTransfers() {
    const expired = state.transfers.filter(
      (transfer) => transfer.state === "pending" && Number.isFinite(transfer.expiresAt) && transfer.expiresAt <= now()
    );
    if (expired.length === 0) {
      return;
    }
    const updatedAt = now();
    for (const transfer of expired) {
      transfer.state = "cancelled";
      transfer.result = normalizeTransferResult({
        status: "failed",
        imported: 0,
        poolEnabled: 0,
        message: "sharing lease expired before confirmation"
      });
      transfer.updatedAt = updatedAt;
    }
    await persist();
  }

  async function expireUsageReadRequests() {
    const current = now();
    const retained = state.usageRequests.filter(
      (request) => request.state === "pending" ? request.expiresAt > current : request.expiresAt + USAGE_REQUEST_TTL_MS > current
    );
    if (retained.length !== state.usageRequests.length) {
      state.usageRequests = retained;
      await persist();
    }
  }

  function assertBootstrapToken(token) {
    if (!secretsEqual(normalizedBootstrapToken, token)) {
      throw httpError(401, "sharing relay enrollment token is invalid");
    }
  }

  function assertAuthenticated(token) {
    if (!normalizeSecret(token)) {
      throw httpError(401, "sharing relay authentication is required");
    }
  }

  function assertUserToken(userId, token) {
    if (!state.users[userId] || !secretsEqual(state.users[userId].mailboxTokenHash, hashSecret(token))) {
      throw httpError(401, "sharing relay user authentication is invalid");
    }
  }

  function requireUser(userId) {
    const normalized = normalizeUserId(userId);
    const user = state.users[normalized];
    if (!user) {
      throw httpError(404, "sharing user not found");
    }
    return user;
  }

  function requireTrustedPeer(userId, peerUserId) {
    requireUser(peerUserId);
    const accepted = state.requests.some(
      (request) =>
        request.state === "accepted" &&
        ((request.fromUserId === userId && request.toUserId === peerUserId) ||
          (request.fromUserId === peerUserId && request.toUserId === userId))
    );
    if (!accepted) {
      throw httpError(403, "credential sync requires an accepted sharing peer");
    }
  }

  function requireActiveCredentialSync(syncId, fromUserId) {
    const sync = state.credentialSyncs.find(
      (candidate) => candidate.syncId === syncId && candidate.fromUserId === fromUserId && candidate.state === "active"
    );
    if (!sync) {
      throw httpError(404, "active credential sync not found");
    }
    requireTrustedPeer(fromUserId, sync.toUserId);
    return sync;
  }

  function requireActiveCredentialSyncForFollower(syncId, toUserId) {
    const sync = state.credentialSyncs.find(
      (candidate) => candidate.syncId === syncId && candidate.toUserId === toUserId && candidate.state === "active"
    );
    if (!sync) {
      throw httpError(404, "active credential sync not found");
    }
    requireTrustedPeer(toUserId, sync.fromUserId);
    return sync;
  }

  function pruneStoppedCredentialSyncs() {
    state.credentialSyncs = state.credentialSyncs.filter(
      (sync) => sync.state !== "stopped" || new Set(sync.stopAcknowledgedBy ?? []).size < 2
    );
  }

  function pruneState() {
    const requestIdsByUser = new Map();
    const transferIdsByUser = new Map();
    const usageRequestIdsByUser = new Map();
    const usageUpdateIdsByUser = new Map();
    for (const request of state.requests) {
      appendBounded(requestIdsByUser, request.toUserId, request.id, MAX_REQUESTS_PER_USER);
      appendBounded(requestIdsByUser, request.fromUserId, request.id, MAX_REQUESTS_PER_USER);
    }
    for (const transfer of state.transfers) {
      appendBounded(transferIdsByUser, transfer.toUserId, transfer.id, MAX_TRANSFERS_PER_USER);
      appendBounded(transferIdsByUser, transfer.fromUserId, transfer.id, MAX_TRANSFERS_PER_USER);
    }
    for (const request of state.usageRequests) {
      appendBounded(usageRequestIdsByUser, request.toUserId, request.id, MAX_USAGE_REQUESTS_PER_USER);
      appendBounded(usageRequestIdsByUser, request.fromUserId, request.id, MAX_USAGE_REQUESTS_PER_USER);
    }
    for (const update of state.usageUpdates) {
      appendBounded(usageUpdateIdsByUser, update.toUserId, update.syncId, MAX_USAGE_UPDATES_PER_USER);
      appendBounded(usageUpdateIdsByUser, update.fromUserId, update.syncId, MAX_USAGE_UPDATES_PER_USER);
    }
    state.requests = state.requests.filter((request) =>
      requestIdsByUser.get(request.toUserId)?.includes(request.id) || requestIdsByUser.get(request.fromUserId)?.includes(request.id)
    );
    state.transfers = state.transfers.filter((transfer) =>
      transferIdsByUser.get(transfer.toUserId)?.includes(transfer.id) || transferIdsByUser.get(transfer.fromUserId)?.includes(transfer.id)
    );
    state.usageRequests = state.usageRequests.filter((request) =>
      usageRequestIdsByUser.get(request.toUserId)?.includes(request.id) ||
      usageRequestIdsByUser.get(request.fromUserId)?.includes(request.id)
    );
    state.usageUpdates = state.usageUpdates.filter(
      (update) =>
        usageUpdateIdsByUser.get(update.toUserId)?.includes(update.syncId) ||
        usageUpdateIdsByUser.get(update.fromUserId)?.includes(update.syncId)
    );
  }

  function pruneUsageReadRequests() {
    pruneState();
  }

  function pruneUsageUpdates() {
    pruneState();
  }

  function appendBounded(map, key, value, maximum) {
    const values = map.get(key) ?? [];
    values.push(value);
    while (values.length > maximum) {
      values.shift();
    }
    map.set(key, values);
  }

  async function persist() {
    await ensureInitialized();
    const encoded = JSON.stringify(state, null, 2);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeQueue = writeQueue.then(async () => {
      await writeFile(temporaryPath, encoded, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    await writeQueue;
  }
}

export function publicProfile(user) {
  return {
    userId: user.userId,
    displayName: user.displayName,
    identityPublicKey: user.identityPublicKey,
    encryptionPublicKey: user.encryptionPublicKey,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function publicRequest(request) {
  return { ...request };
}

function publicTransfer(transfer) {
  return {
    id: transfer.id,
    fromUserId: transfer.fromUserId,
    toUserId: transfer.toUserId,
    expiresAt: transfer.expiresAt,
    envelope: transfer.envelope,
    state: transfer.state,
    returnedAccountIds: transfer.returnedAccountIds,
    returnEnvelopes: transfer.returnEnvelopes,
    ownerConfirmedAccountIds: transfer.ownerConfirmedAccountIds,
    result: transfer.result,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt
  };
}

function publicCredentialSync(sync) {
  return {
    syncId: sync.syncId,
    fromUserId: sync.fromUserId,
    toUserId: sync.toUserId,
    version: sync.version,
    eventId: sync.eventId,
    envelope: sync.envelope,
    state: sync.state,
    stoppedBy: sync.stoppedBy,
    acknowledgedVersion: sync.acknowledgedVersion,
    createdAt: sync.createdAt,
    updatedAt: sync.updatedAt
  };
}

function publicUsageReadRequest(request) {
  return {
    id: request.id,
    syncId: request.syncId,
    fromUserId: request.fromUserId,
    toUserId: request.toUserId,
    state: request.state,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    response: request.response
  };
}

function publicUsageUpdate(update) {
  return {
    syncId: update.syncId,
    fromUserId: update.fromUserId,
    toUserId: update.toUserId,
    revision: update.revision,
    eventId: update.eventId,
    envelope: update.envelope,
    updatedAt: update.updatedAt
  };
}

function normalizeSyncId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SYNC_ID_PATTERN.test(normalized)) {
    throw httpError(400, "credential sync ID is invalid");
  }
  return normalized;
}

function normalizeEventId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(normalized)) {
    throw httpError(400, "credential sync event ID is invalid");
  }
  return normalized;
}

function normalizeCredentialEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "encrypted credential sync envelope is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENVELOPE_BYTES) {
    throw httpError(400, "encrypted credential sync envelope is too large");
  }
  return value;
}

function normalizeUsageEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "encrypted account usage envelope is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_USAGE_ENVELOPE_BYTES) {
    throw httpError(400, "encrypted account usage envelope is too large");
  }
  return value;
}

function normalizeSyncIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw httpError(400, "usage read sync IDs are invalid");
  }
  return Array.from(new Set(value.map(normalizeSyncId)));
}

function normalizeReturnEnvelope(value, accountIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value.envelope && typeof value.envelope === "object" ? value.envelope : value;
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (envelopeBytes > MAX_ENVELOPE_BYTES) {
    throw httpError(400, "encrypted return envelope is invalid or too large");
  }
  return {
    accountIds: normalizeAccountIds(accountIds),
    envelope
  };
}

function normalizeAccountIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((accountId) => typeof accountId === "string")
        .map((accountId) => accountId.trim())
        .filter(Boolean)
    )
  ).slice(0, 50);
}

function normalizeProfile(value) {
  const userId = normalizeUserId(value?.userId);
  const displayName = normalizeDisplayName(value?.displayName);
  const identityPublicKey = normalizeKey(value?.identityPublicKey, "identityPublicKey");
  const encryptionPublicKey = normalizeKey(value?.encryptionPublicKey, "encryptionPublicKey");
  return { userId, displayName, identityPublicKey, encryptionPublicKey };
}

function normalizeUserId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!USER_ID_PATTERN.test(normalized)) {
    throw httpError(400, "sharing user ID is invalid");
  }
  return normalized;
}

function normalizeDisplayName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw httpError(400, "sharing display name is invalid");
  }
  return normalized;
}

function normalizeKey(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 4096 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(normalized)) {
    throw httpError(400, `${field} is invalid`);
  }
  return normalized;
}

function normalizeSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hashSecret(value) {
  return createHash("sha256").update(normalizeSecret(value)).digest("hex");
}

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(normalizeSecret(left));
  const rightBuffer = Buffer.from(normalizeSecret(right));
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeTransferResult(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return {
    status: value.status === "completed" || value.status === "partial" ? value.status : "failed",
    imported: Number.isInteger(value.imported) ? Math.max(0, value.imported) : 0,
    poolEnabled: Number.isInteger(value.poolEnabled) ? Math.max(0, value.poolEnabled) : 0,
    message: typeof value.message === "string" ? value.message.slice(0, 240) : undefined
  };
}

function emptyState() {
  return {
    version: STATE_VERSION,
    users: {},
    requests: [],
    transfers: [],
    credentialSyncs: [],
    usageRequests: [],
    usageUpdates: []
  };
}

function parseState(value) {
  if (!value || value.version !== STATE_VERSION || typeof value.users !== "object" || !Array.isArray(value.requests) || !Array.isArray(value.transfers)) {
    throw new Error("unsupported sharing relay state");
  }
  return {
    version: STATE_VERSION,
    users: value.users,
    requests: value.requests,
    transfers: value.transfers,
    credentialSyncs: Array.isArray(value.credentialSyncs) ? value.credentialSyncs : [],
    usageRequests: Array.isArray(value.usageRequests) ? value.usageRequests : [],
    usageUpdates: Array.isArray(value.usageUpdates) ? value.usageUpdates : []
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
