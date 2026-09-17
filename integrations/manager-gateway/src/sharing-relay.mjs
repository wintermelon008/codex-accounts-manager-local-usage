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

  function pruneState() {
    const requestIdsByUser = new Map();
    const transferIdsByUser = new Map();
    for (const request of state.requests) {
      appendBounded(requestIdsByUser, request.toUserId, request.id, MAX_REQUESTS_PER_USER);
      appendBounded(requestIdsByUser, request.fromUserId, request.id, MAX_REQUESTS_PER_USER);
    }
    for (const transfer of state.transfers) {
      appendBounded(transferIdsByUser, transfer.toUserId, transfer.id, MAX_TRANSFERS_PER_USER);
      appendBounded(transferIdsByUser, transfer.fromUserId, transfer.id, MAX_TRANSFERS_PER_USER);
    }
    state.requests = state.requests.filter((request) =>
      requestIdsByUser.get(request.toUserId)?.includes(request.id) || requestIdsByUser.get(request.fromUserId)?.includes(request.id)
    );
    state.transfers = state.transfers.filter((transfer) =>
      transferIdsByUser.get(transfer.toUserId)?.includes(transfer.id) || transferIdsByUser.get(transfer.fromUserId)?.includes(transfer.id)
    );
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
  return { version: STATE_VERSION, users: {}, requests: [], transfers: [] };
}

function parseState(value) {
  if (!value || value.version !== STATE_VERSION || typeof value.users !== "object" || !Array.isArray(value.requests) || !Array.isArray(value.transfers)) {
    throw new Error("unsupported sharing relay state");
  }
  return {
    version: STATE_VERSION,
    users: value.users,
    requests: value.requests,
    transfers: value.transfers
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
