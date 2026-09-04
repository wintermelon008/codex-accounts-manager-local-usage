export class ManagerControlError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "ManagerControlError";
    this.statusCode = statusCode;
  }
}

export function createManagerClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不支持 fetch。请使用 Node 22.5 或更新版本。");
  }
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    getHealth: () => request("/healthz"),
    getStatus: () => request("/api/manager/status"),
    getAccounts: () => request("/api/manager/accounts"),
    getCodexExecProviderConfig: () => request("/api/manager/codex/provider-config"),
    switchAccount: (accountId, switchOptions = {}) => request("/api/manager/accounts/switch", {
      method: "POST",
      body: JSON.stringify({ accountId, force: switchOptions.force === true })
    }),
    async getActiveAccount() {
      const body = await request("/api/manager/accounts");
      const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
      const active = accounts.find((account) => account?.isActive === true || account?.providerActive === true);
      if (!active?.id) {
        throw new ManagerControlError("Manager 没有可识别的活动账号。", 409);
      }
      return {
        id: active.id,
        email: typeof active.email === "string" ? active.email : undefined,
        displayName: typeof active.displayName === "string" ? active.displayName : undefined
      };
    }
  };

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
      }
      headers.set("accept", "application/json");
      if (init.body !== undefined) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const body = await readJson(response);
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? body.error : "Manager 控制接口返回错误。";
        throw new ManagerControlError(`${detail}（HTTP ${response.status}）`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof ManagerControlError) {
        throw error;
      }
      if (error?.name === "AbortError") {
        throw new ManagerControlError("Manager 控制接口响应超时。", undefined);
      }
      throw new ManagerControlError("无法连接到 Manager 控制接口。", undefined);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
