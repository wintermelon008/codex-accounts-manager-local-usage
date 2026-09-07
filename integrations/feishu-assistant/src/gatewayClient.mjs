export class GatewayClientError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "GatewayClientError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "quota_exhausted"]);

/**
 * Small Feishu-side adapter for the Manager Gateway. It deliberately keeps
 * only the chat-to-session mapping in memory; the Gateway remains the owner
 * of session history and token accounting.
 */
export function createGatewayClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不支持 fetch。请使用 Node 20 或更新版本。 ");
  }
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const sessionByChat = new Map();

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      if (init.body !== undefined) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
      }
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const body = await readJson(response);
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? body.error : "Gateway 请求返回错误。";
        throw new GatewayClientError(`${detail}（HTTP ${response.status}）`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof GatewayClientError) {
        throw error;
      }
      if (error?.name === "AbortError") {
        throw new GatewayClientError("Gateway 请求超时。 ");
      }
      throw new GatewayClientError("无法连接到 Manager Gateway。 ");
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getHealth() {
      return request("/healthz");
    },
    getCapabilities() {
      return request("/v1/capabilities");
    },
    async getUsageToday() {
      const usage = await request("/v1/usage/today");
      return usage && typeof usage === "object" ? { ...usage, source: "gateway" } : usage;
    },
    async getStatus() {
      const [capabilities, usageToday] = await Promise.all([
        request("/v1/capabilities"),
        request("/v1/usage/today")
      ]);
      return {
        usageToday: usageToday && typeof usageToday === "object"
          ? { ...usageToday, source: "gateway" }
          : usageToday,
        gatewayCapabilities: capabilities
      };
    },
    async sendMessage(chatId, message) {
      const key = typeof chatId === "string" && chatId.trim() ? chatId.trim() : "default";
      let sessionId = sessionByChat.get(key);
      if (sessionId) {
        try {
          await request(`${sessionPath(sessionId)}/messages`, {
            method: "POST",
            body: JSON.stringify({ message })
          });
        } catch (error) {
          if (error?.statusCode !== 404) {
            throw error;
          }
          sessionByChat.delete(key);
          sessionId = undefined;
        }
      }

      if (!sessionId) {
        const payload = await request("/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ mode: "develop", message })
        });
        sessionId = readSessionId(payload);
        if (!sessionId) {
          throw new GatewayClientError("Gateway 没有返回有效的会话编号。 ");
        }
        sessionByChat.set(key, sessionId);
      }

      return waitForTerminal(sessionId);
    }
  };

  async function waitForTerminal(sessionId) {
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      const session = await request(sessionPath(sessionId));
      if (isFinished(session)) {
        if (session.status !== "completed") {
          throw new GatewayClientError(
            session.error?.message || `Gateway 会话以 ${session.status || "unknown"} 状态结束。`
          );
        }
        return session.result?.text || "Gateway 会话已完成，但没有返回文本。";
      }
      await delay(pollIntervalMs);
    }
    throw new GatewayClientError("Gateway 会话仍在运行，等待已超时；可稍后发送“状态”查询。 ");
  }
}

function readSessionId(payload) {
  const session = payload && typeof payload === "object" ? payload.session : undefined;
  const value = session && typeof session === "object" ? session.id : undefined;
  return typeof payload?.sessionId === "string" && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : typeof value === "string" && value.trim()
      ? value.trim()
      : undefined;
}

function isFinished(session) {
  return TERMINAL_STATUSES.has(session?.status) && !(session.status === "quota_exhausted" && session.recoveryPending === true);
}

function sessionPath(sessionId) {
  return `/v1/sessions/${encodeURIComponent(sessionId)}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
