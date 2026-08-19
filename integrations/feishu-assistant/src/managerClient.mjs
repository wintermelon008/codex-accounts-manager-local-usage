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
    throw new Error("当前 Node 运行时不支持 fetch。请使用 Node 20 或更新版本。");
  }
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    getHealth() {
      return request("/healthz");
    },
    getStatus() {
      return request("/api/manager/status");
    },
    getAccounts() {
      return request("/api/manager/accounts");
    },
    getUsageToday() {
      return request("/api/manager/usage/today");
    },
    refreshQuotas(accountIds) {
      const body = accountIds === undefined ? undefined : { accountIds };
      return request("/api/manager/quotas/refresh", {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    },
    enqueueImport(accounts) {
      return request("/api/manager/imports", {
        method: "POST",
        body: JSON.stringify({ accounts })
      });
    },
    getJob(jobId) {
      return request(`/api/manager/jobs/${encodeURIComponent(jobId)}`);
    },
    getImportStatus(jobId) {
      return request(`/api/manager/imports/${encodeURIComponent(jobId)}`);
    }
  };

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${options.token}`);
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
      throw new ManagerControlError("无法连接到本机 Manager 控制接口。", undefined);
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
