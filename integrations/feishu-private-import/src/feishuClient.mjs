const DEFAULT_API_BASE = "https://open.feishu.cn";

export function createFeishuClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不支持 fetch。请使用 Node 20 或更新版本。");
  }
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, "");
  let cachedToken;
  let cachedUntil = 0;

  async function tenantAccessToken() {
    if (cachedToken && Date.now() < cachedUntil) {
      return cachedToken;
    }
    const response = await fetchImpl(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret })
    });
    const body = await readJson(response);
    if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== "string" || !body.tenant_access_token) {
      throw new Error("飞书租户令牌请求失败。");
    }
    cachedToken = body.tenant_access_token;
    const expiresIn = Number.isFinite(body.expire) ? body.expire : 6_000;
    cachedUntil = Date.now() + Math.max(60, expiresIn - 60) * 1_000;
    return cachedToken;
  }

  return {
    async sendText(chatId, text) {
      if (typeof chatId !== "string" || !chatId || typeof text !== "string" || !text) {
        throw new Error("飞书回复参数无效。");
      }
      const token = await tenantAccessToken();
      const response = await fetchImpl(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) })
      });
      const body = await readJson(response);
      if (!response.ok || body.code !== 0) {
        throw new Error("飞书消息发送失败。");
      }
    }
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
