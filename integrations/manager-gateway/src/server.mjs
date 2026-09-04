import http from "node:http";

const MAX_BODY_BYTES = 1_000_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "quota_exhausted"]);

export function createGatewayServer({ sessions, config }) {
  return http.createServer((request, response) => {
    void handleRequest(request, response, { sessions, config }).catch((error) => {
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

async function handleRequest(request, response, { sessions, config }) {
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
    sendJson(response, 200, {
      api: "v1",
      modes: ["research", "develop"],
      sessionEvents: true,
      cancellation: true,
      interjection: typeof sessions.interject === "function",
      accountSwitch,
      recoveryStatus: true,
      developWorktree,
      maxSessions: sessions.maxSessions
    }, config);
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
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "session request must be valid JSON and no larger than 1 MB" }, config);
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
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS"
      }
    : {};
}
