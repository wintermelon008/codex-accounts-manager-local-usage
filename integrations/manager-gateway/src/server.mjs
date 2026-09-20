import http from "node:http";
import { appendFile } from "node:fs/promises";
import path from "node:path";

const MAX_BODY_BYTES = 1_000_000;
const MAX_SESSION_BODY_BYTES = 8_000_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "quota_exhausted"]);

export function createGatewayServer({ sessions, config, usage, sharingRelay, attachments }) {
  return http.createServer((request, response) => {
    void handleRequest(request, response, { sessions, config, usage, sharingRelay, attachments }).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }, config);
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
}

export function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Gateway did not expose a TCP address"));
        return;
      }
      resolve({ host, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function handleRequest(request, response, { sessions, config, usage, sharingRelay, attachments }) {
  const url = new URL(request.url ?? "/", `http://${config.server.host}`);
  applyCors(response, config);
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(config));
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, service: "codex-accounts-manager-gateway", api: "v1" }, config);
    return;
  }
  if (url.pathname === "/v1/sharing" || url.pathname.startsWith("/v1/sharing/")) {
    await handleSharingRequest(request, response, url, sharingRelay, config);
    return;
  }
  if (url.pathname === "/v1/attachments" || /^\/v1\/attachments\/[^/]+$/u.test(url.pathname)) {
    await handleAttachmentRequest(request, response, url, attachments, config);
    return;
  }
  if (!isAuthorized(request, config.server.token)) {
    sendJson(response, 401, { error: "unauthorized" }, config);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    const accountSwitch = typeof sessions.canSwitchAccounts === "function"
      ? sessions.canSwitchAccounts()
      : Boolean(sessions.manager?.switchAccount);
    const developWorktree = typeof sessions.hasWorktreeSupport === "function"
      ? sessions.hasWorktreeSupport()
      : false;
    const capabilities = {
      api: "v1",
      modes: ["research", "develop"],
      sessionEvents: true,
      cancellation: true,
      interjection: typeof sessions.interject === "function",
      accountSwitch,
      recoveryStatus: true,
      developWorktree,
      maxSessions: sessions.maxSessions
    };
    if (typeof usage?.snapshot === "function") {
      capabilities.tokenUsage = true;
    }
    sendJson(response, 200, capabilities, config);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/usage/today") {
    sendJson(response, 200, usage?.snapshot?.() ?? unavailableUsage(), config);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/manager/accounts") {
    if (typeof sessions.manager?.getAccounts !== "function") {
      sendJson(response, 503, { error: "Manager account directory is unavailable" }, config);
      return;
    }
    try {
      sendJson(response, 200, await sessions.manager.getAccounts(), config);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/manager/status") {
    if (typeof sessions.manager?.getStatus !== "function") {
      sendJson(response, 503, { error: "Manager status is unavailable" }, config);
      return;
    }
    try {
      sendJson(response, 200, await sessions.manager.getStatus(), config);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/manager/proxy") {
    if (typeof sessions.manager?.getProxySettings !== "function") {
      sendJson(response, 503, { error: "Manager proxy configuration is unavailable" }, config);
      return;
    }
    try {
      sendJson(response, 200, await sessions.manager.getProxySettings(), config);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/recovery") {
    sendJson(response, 200, sessions.getRecoveryStatus(), config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/accounts/switch") {
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "switch request must be valid JSON and no larger than 1 MB" }, config);
      return;
    }
    const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) {
      sendJson(response, 400, { error: "accountId is required" }, config);
      return;
    }
    try {
      sendJson(response, 200, await sessions.manualSwitch(accountId), config);
    } catch (error) {
      sendJson(response, managerSwitchErrorStatus(error), { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/sessions") {
    sendJson(response, 200, { sessions: sessions.list() }, config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    let body;
    try {
      body = await readJsonBody(request, MAX_SESSION_BODY_BYTES);
    } catch {
      sendJson(response, 400, { error: "session request must be valid JSON and no larger than 8 MB" }, config);
      return;
    }
    let session;
    try {
      session = sessions.create(body);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }, config);
      return;
    }
    sendJson(response, 201, { sessionId: session.id, session }, config);
    return;
  }

  const match = /^\/v1\/sessions\/([^/]+)(?:\/(events|cancel|apply|discard|messages))?$/u.exec(url.pathname);
  if (!match) {
    sendJson(response, 404, { error: "not found" }, config);
    return;
  }
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  if (!action && request.method === "DELETE") {
    if (typeof sessions.remove !== "function") {
      sendJson(response, 503, { error: "session deletion is unavailable" }, config);
      return;
    }
    try {
      if (!sessions.remove(id)) {
        sendJson(response, 404, { error: "session not found" }, config);
        return;
      }
      sendJson(response, 200, { deleted: true, sessionId: id }, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error?.statusCode === 409 ? 409 : 500;
      sendJson(response, status, { error: message }, config);
    }
    return;
  }
  if (!action && request.method === "GET") {
    const session = sessions.get(id);
    if (!session) {
      sendJson(response, 404, { error: "session not found" }, config);
      return;
    }
    sendJson(response, 200, session, config);
    return;
  }
  if (action === "cancel" && request.method === "POST") {
    const session = sessions.cancel(id);
    if (!session) {
      sendJson(response, 404, { error: "session not found" }, config);
      return;
    }
    sendJson(response, 202, { session }, config);
    return;
  }
  if (action === "messages" && request.method === "POST") {
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "message request must be valid JSON and no larger than 1 MB" }, config);
      return;
    }
    try {
      const session = body?.interject === true && typeof sessions.interject === "function"
        ? sessions.interject(id, body)
        : sessions.send(id, body);
      sendJson(response, 202, { session }, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error?.statusCode === 404 ? 404 : error?.statusCode === 409 ? 409 : 400;
      sendJson(response, status, { error: message }, config);
    }
    return;
  }
  if ((action === "apply" || action === "discard") && request.method === "POST") {
    if (typeof sessions.hasWorktreeSupport === "function" && !sessions.hasWorktreeSupport()) {
      sendJson(response, 503, { error: "develop worktree is unavailable" }, config);
      return;
    }
    try {
      const session = await sessions[action](id);
      sendJson(response, 200, { session }, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message === "session not found" ? 404 : 409, { error: message }, config);
    }
    return;
  }
  if (action === "events" && request.method === "GET") {
    streamEvents(request, response, sessions, id, config);
    return;
  }
  sendJson(response, 405, { error: "method not allowed" }, config);
}

async function handleSharingRequest(request, response, url, sharingRelay, config) {
  if (!sharingRelay) {
    sendJson(response, 503, { error: "account sharing relay is not configured" }, config);
    return;
  }

  try {
    await sharingRelay.init();
    const token = readBearerToken(request);
    const pathname = url.pathname;

    if (pathname === "/v1/sharing/register" && request.method === "POST") {
      let body;
      try {
        body = await readJsonBody(request, 32 * 1024);
      } catch {
        sendJson(response, 400, { error: "sharing profile must be valid JSON" }, config);
        return;
      }
      const bootstrapAccepted = sharingRelay.isBootstrapToken(token);
      writeSharingAudit(config, `register bootstrap=${bootstrapAccepted ? "accepted" : "rejected"}`);
      if (!bootstrapAccepted) {
        sendJson(response, 401, { error: "sharing relay enrollment token is invalid" }, config);
        return;
      }
      sendJson(response, 201, await sharingRelay.registerProfile(body, token), config);
      return;
    }

    const auth = await authenticateSharingRequest(sharingRelay, token);
    if (!auth) {
      writeSharingAudit(config, `auth-rejected method=${request.method} path=${pathname}`);
      sendJson(response, 401, { error: "sharing relay authentication is invalid" }, config);
      return;
    }

    if (pathname === "/v1/sharing/me" && request.method === "GET") {
      if (!auth.userId) {
        sendJson(response, 401, { error: "a registered sharing user token is required" }, config);
        return;
      }
      sendJson(response, 200, auth, config);
      return;
    }

    const userMatch = /^\/v1\/sharing\/users\/([^/]+)$/u.exec(pathname);
    if (request.method === "GET" && userMatch?.[1]) {
      const userId = decodeURIComponent(userMatch[1]);
      const profile = await sharingRelay.lookupUser(userId, token);
      if (!profile) {
        sendJson(response, 404, { error: "sharing user not found" }, config);
        return;
      }
      sendJson(response, 200, profile, config);
      return;
    }

    if (!auth.userId) {
      sendJson(response, 401, { error: "a registered sharing user token is required" }, config);
      return;
    }

    if (pathname === "/v1/sharing/requests" && request.method === "POST") {
      const body = await readJsonBody(request, 32 * 1024);
      sendJson(response, 201, await sharingRelay.createRequest(auth.userId, body?.toUserId, token), config);
      return;
    }
    if (pathname === "/v1/sharing/requests/inbox" && request.method === "GET") {
      sendJson(response, 200, { requests: await sharingRelay.listIncomingRequests(auth.userId, token) }, config);
      return;
    }
    if (pathname === "/v1/sharing/requests/mine" && request.method === "GET") {
      sendJson(response, 200, { requests: await sharingRelay.listRequestsForUser(auth.userId, token) }, config);
      return;
    }
    const peerRemoveMatch = /^\/v1\/sharing\/peers\/([^/]+)\/remove$/u.exec(pathname);
    if (request.method === "POST" && peerRemoveMatch?.[1]) {
      sendJson(
        response,
        200,
        await sharingRelay.removePeer(auth.userId, decodeURIComponent(peerRemoveMatch[1]), token),
        config
      );
      return;
    }
    const requestMatch = /^\/v1\/sharing\/requests\/([^/]+)\/(accept|reject)$/u.exec(pathname);
    if (request.method === "POST" && requestMatch?.[1] && requestMatch[2]) {
      sendJson(
        response,
        200,
        await sharingRelay.updateRequest(
          decodeURIComponent(requestMatch[1]),
          auth.userId,
          requestMatch[2] === "accept",
          token
        ),
        config
      );
      return;
    }

    if (pathname === "/v1/sharing/transfers" && request.method === "POST") {
      const body = await readJsonBody(request, 4 * 1024 * 1024);
      sendJson(response, 201, await sharingRelay.createTransfer(auth.userId, body, token), config);
      return;
    }
    if (pathname === "/v1/sharing/transfers/inbox" && request.method === "GET") {
      const transfers = await sharingRelay.listIncomingTransfers(auth.userId, token);
      writeSharingAudit(
        config,
        `inbox user=${auth.userId} count=${transfers.length} ids=${transfers.map((transfer) => transfer.id).join(",")}`
      );
      sendJson(response, 200, { transfers }, config);
      return;
    }
    if (pathname === "/v1/sharing/transfers/sent" && request.method === "GET") {
      const transfers = await sharingRelay.listSentTransfers(auth.userId, token);
      writeSharingAudit(
        config,
        `sent user=${auth.userId} count=${transfers.length} states=${transfers
          .map((transfer) => `${transfer.id}:${transfer.state}`)
          .join(",")}`
      );
      sendJson(response, 200, { transfers }, config);
      return;
    }
    const transferStatusMatch = /^\/v1\/sharing\/transfers\/([^/]+)$/u.exec(pathname);
    if (request.method === "GET" && transferStatusMatch?.[1]) {
      sendJson(
        response,
        200,
        await sharingRelay.getTransferForRecipient(decodeURIComponent(transferStatusMatch[1]), auth.userId, token),
        config
      );
      return;
    }
    const transferMatch = /^\/v1\/sharing\/transfers\/([^/]+)\/(ack|return|confirm-return|cancel)$/u.exec(pathname);
    if (request.method === "POST" && transferMatch?.[1] && transferMatch[2]) {
      const transferId = decodeURIComponent(transferMatch[1]);
      if (transferMatch[2] === "return") {
        const body = await readJsonBody(request, 4 * 1024 * 1024).catch(() => undefined);
        sendJson(
          response,
          200,
          await sharingRelay.returnTransfer(transferId, auth.userId, body, token),
          config
        );
        return;
      }
      if (transferMatch[2] === "confirm-return") {
        const body = await readJsonBody(request, 32 * 1024);
        sendJson(
          response,
          200,
          await sharingRelay.confirmReturn(transferId, auth.userId, body?.accountIds, token),
          config
        );
        return;
      }
      if (transferMatch[2] === "cancel") {
        sendJson(response, 200, await sharingRelay.cancelTransfer(transferId, auth.userId, token), config);
        return;
      }
      const body = await readJsonBody(request, 32 * 1024);
      sendJson(response, 200, await sharingRelay.acknowledgeTransfer(transferId, auth.userId, body, token), config);
      return;
    }

    sendJson(response, 404, { error: "not found" }, config);
  } catch (error) {
    const status = typeof error?.statusCode === "number" ? error.statusCode : 400;
    writeSharingAudit(config, `request-failed method=${request.method} path=${url.pathname} status=${status}`);
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) }, config);
  }
}

async function handleAttachmentRequest(request, response, url, attachments, config) {
  if (!attachments) {
    sendJson(response, 503, { error: "Gateway attachment storage is unavailable" }, config);
    return;
  }

  const idMatch = /^\/v1\/attachments\/([^/]+)$/u.exec(url.pathname);
  const id = idMatch ? decodeURIComponent(idMatch[1]) : undefined;
  const stored = id ? attachments.get(id) : undefined;

  if (request.method === "POST" && url.pathname === "/v1/attachments") {
    if (!isAuthorized(request, config.server.token)) {
      sendJson(response, 401, { error: "unauthorized" }, config);
      return;
    }
    try {
      const bytes = await readBinaryBody(request, attachments.maxBytes);
      const attachment = await attachments.create({
        filename: decodeFilename(request.headers["x-manager-filename"]),
        mimeType: request.headers["content-type"],
        bytes,
        publicBaseUrl: attachmentPublicBaseUrl(request, config)
      });
      sendJson(response, 201, { attachment }, config);
    } catch (error) {
      const status = typeof error?.statusCode === "number" ? error.statusCode : 400;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }

  if (!id || !stored) {
    sendJson(response, 404, { error: "attachment not found" }, config);
    return;
  }

  const accessToken = url.searchParams.get("access_token");
  if (!isAuthorized(request, config.server.token) && !attachments.isAccessTokenValid(id, accessToken)) {
    sendJson(response, 401, { error: "unauthorized" }, config);
    return;
  }

  if (request.method === "GET") {
    try {
      const result = await attachments.read(id);
      if (!result) {
        sendJson(response, 404, { error: "attachment not found" }, config);
        return;
      }
      const filename = safeAttachmentFilename(result.metadata.filename);
      response.writeHead(200, {
        ...corsHeaders(config),
        "content-type": result.metadata.mimeType,
        "content-length": result.bytes.length,
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(result.bytes);
    } catch (error) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : String(error) }, config);
    }
    return;
  }

  if (request.method === "DELETE") {
    await attachments.remove(id);
    sendJson(response, 200, { deleted: true, attachmentId: id }, config);
    return;
  }

  sendJson(response, 405, { error: "method not allowed" }, config);
}

function writeSharingAudit(config, message) {
  const stateDir = config?.sharing?.stateDir;
  if (typeof stateDir !== "string" || !stateDir) {
    return;
  }
  void appendFile(
    path.join(stateDir, "sharing-relay-audit.log"),
    `${new Date().toISOString()} ${message}\n`,
    { encoding: "utf8", mode: 0o600 }
  ).catch(() => undefined);
}

async function authenticateSharingRequest(sharingRelay, token) {
  if (sharingRelay.isBootstrapToken(token)) {
    return { userId: undefined, bootstrap: true };
  }
  return sharingRelay.authenticate(token);
}

function readBearerToken(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function unavailableUsage() {
  return {
    status: "unavailable",
    date: undefined,
    timeZone: undefined,
    calculatedAt: undefined,
    eventCount: 0,
    total: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    },
    byModel: []
  };
}

function streamEvents(request, response, sessions, id, config) {
  const session = sessions.get(id);
  if (!session) {
    sendJson(response, 404, { error: "session not found" }, config);
    return;
  }
  response.writeHead(200, {
    ...corsHeaders(config),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const history = sessions.getEvents(id) ?? [];
  const lastTerminalEvent = [...history].reverse().find((event) =>
    event.type === "session.recovery_failed" || event.type === "session.terminal"
  );
  const terminalInHistory = lastTerminalEvent
    ? isFinalTerminalEvent(lastTerminalEvent, sessions, id) && isCurrentSessionTerminal(sessions, id)
    : false;
  const send = (event) => {
    if (!response.destroyed) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  send({ type: "session.snapshot", at: Date.now(), session });
  for (const event of history) {
    send(event);
  }
  let closed = false;
  const unsubscribe = sessions.subscribe(id, (event) => {
    send(event);
    if (event.type === "session.recovery_failed" || (event.type === "session.terminal" && !isPendingQuotaTerminal(event, sessions, id))) {
      cleanup();
      response.end();
    }
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed) {
      response.write(": heartbeat\n\n");
    }
  }, 15_000);
  heartbeat.unref();
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  if (terminalInHistory || (TERMINAL_STATUSES.has(sessions.get(id)?.status) && !sessions.isRecoveryPending?.(id))) {
    cleanup();
    response.end();
    return;
  }
  request.on("close", cleanup);
}

function isFinalTerminalEvent(event, sessions, id) {
  return event.type === "session.recovery_failed" ||
    (event.type === "session.terminal" && !isPendingQuotaTerminal(event, sessions, id));
}

function isCurrentSessionTerminal(sessions, id) {
  const session = sessions.get(id);
  return Boolean(session && TERMINAL_STATUSES.has(session.status) && !sessions.isRecoveryPending?.(id));
}

function isPendingQuotaTerminal(event, sessions, id) {
  if (event.status !== "quota_exhausted") {
    return false;
  }
  const session = sessions.get(id);
  return sessions.isRecoveryPending?.(id) === true || session?.status === "queued" || session?.status === "running";
}

function managerSwitchErrorStatus(error) {
  return error && typeof error.statusCode === "number" && error.statusCode === 409 ? 409 : 503;
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBinaryBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error("attachment body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthorized(request, token) {
  if (!token) {
    return true;
  }
  const value = request.headers.authorization;
  return typeof value === "string" && value === `Bearer ${token}`;
}

function attachmentPublicBaseUrl(request, config) {
  if (typeof config.server.publicBaseUrl === "string" && config.server.publicBaseUrl) {
    return config.server.publicBaseUrl;
  }
  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"].split(",")[0].trim()
    : "";
  const protocol = forwardedProto === "https" ? "https" : "http";
  const host = typeof request.headers.host === "string" && request.headers.host
    ? request.headers.host
    : `${config.server.host}:${config.server.port}`;
  return `${protocol}://${host}`;
}

function decodeFilename(value) {
  if (typeof value !== "string" || !value.trim()) return "attachment";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeAttachmentFilename(value) {
  return String(value || "attachment")
    .replace(/["\\\r\n]+/gu, "_")
    .slice(0, 180) || "attachment";
}

function sendJson(response, status, body, config) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(config),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded)
  });
  response.end(encoded);
}

function applyCors(response, config) {
  const headers = corsHeaders(config);
  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }
}

function corsHeaders(config) {
  return config.server.corsOrigin
    ? {
        "access-control-allow-origin": config.server.corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-manager-filename",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS"
      }
    : {};
}
