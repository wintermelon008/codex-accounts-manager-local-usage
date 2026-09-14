import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";
import { normalizeTokenUsage } from "./usage.mjs";

const DEFAULT_WORKBENCH_DATA_URL = "http://127.0.0.1:43119";
const FAST_WORKBENCH_AGENTS_URL = new URL("../fast-query/AGENTS.md", import.meta.url);
let fastWorkbenchAgents;

export class GatewayProviderError extends Error {
  constructor(message, code = "provider_error", details = {}) {
    super(message);
    this.name = "GatewayProviderError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class QuotaExhaustionError extends GatewayProviderError {
  constructor(message = "Codex quota exhausted", details = {}) {
    super(message, "quota_exhausted", details);
    this.name = "QuotaExhaustionError";
  }
}

export class SessionCancelledError extends GatewayProviderError {
  constructor(message = "Session cancelled") {
    super(message, "cancelled");
    this.name = "SessionCancelledError";
  }
}

export function createProvider(config, options = {}) {
  const workbenchDataUrl = config.workbenchDataUrl ?? process.env.WORKBENCH_DATA_URL ?? DEFAULT_WORKBENCH_DATA_URL;
  const workbenchDataToken = config.workbenchDataToken ?? process.env.WORKBENCH_DATA_TOKEN;
  const codex = createCodexProvider(
    config.codex,
    options.manager,
    workbenchDataUrl,
    workbenchDataToken
  );
  const research = config.research.baseUrl
    ? createOpenAiCompatibleProvider(config.research)
    : codex;
  return {
    run({ session, emit, signal }) {
      if (session.mode === "research") {
        return research.run({ session, emit, signal });
      }
      return codex.run({ session, emit, signal });
    }
  };
}

function createCodexProvider(config, manager, workbenchDataUrl, workbenchDataToken) {
  return {
    async run({ session, emit, signal }) {
      const root = session.workspace?.cwd ?? config.projectRoot;
      if (!root) {
        throw new GatewayProviderError("开发模式未配置 MANAGER_GATEWAY_PROJECT_ROOT", "project_unconfigured");
      }
      const runtimeProvider = await resolveRuntimeProvider(manager, emit);
      const runtimeProxy = await resolveRuntimeProxy(manager);
      const providerArgs = runtimeProvider ? buildRuntimeProviderArgs(runtimeProvider) : [];
      const commonArgs = [
        "--json",
        "--color",
        "never",
        "--dangerously-bypass-approvals-and-sandbox",
        "--config",
        'approval_policy="never"',
        "--config",
        'web_search="disabled"',
        ...providerArgs
      ];
      const resumeArgs = [
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        ...providerArgs,
        "--config",
        'approval_policy="never"',
        "--config",
        'web_search="disabled"'
      ];
      const resumeThreadId = session.resumeThreadId ?? session.threadId;
      const args = resumeThreadId
        ? ["exec", "resume", ...resumeArgs, resumeThreadId, session.message]
        : ["exec", ...commonArgs, "--cd", root, buildInitialPrompt(session)];
      const environment = {
        ...process.env,
        WORKBENCH_DATA_URL: workbenchDataUrl || DEFAULT_WORKBENCH_DATA_URL
      };
      if (runtimeProxy) {
        applyRuntimeProxy(environment, runtimeProxy);
      }
      if (workbenchDataToken) {
        environment.WORKBENCH_DATA_TOKEN = workbenchDataToken;
      }
      if (config.home) {
        environment.CODEX_HOME = config.home;
      }
      if (runtimeProvider) {
        environment.CODEX_ACCOUNTS_GATEWAY_ADAPTER_TOKEN = runtimeProvider.token;
      }
      try {
        return await runCodexProcess({
          binary: config.binary,
          args,
          cwd: root,
          env: environment,
          timeoutSeconds: config.timeoutSeconds,
          modelHint: runtimeProvider?.route === "gateway" ? runtimeProvider.model : config.model,
          emit,
          signal
        });
      } catch (error) {
        if (!resumeThreadId || signal?.aborted || error?.code !== "codex_failed") {
          throw error;
        }
        emit({ type: "session.resume_fallback", message: "原 Codex thread 无法恢复，改用任务上下文启动新 session" });
        return runCodexProcess({
          binary: config.binary,
          args: ["exec", ...commonArgs, "--cd", root, buildSemanticResumePrompt(session)],
          cwd: root,
          env: environment,
          timeoutSeconds: config.timeoutSeconds,
          modelHint: runtimeProvider?.route === "gateway" ? runtimeProvider.model : config.model,
          emit,
          signal
        });
      }
    }
  };
}

async function resolveRuntimeProxy(manager) {
  if (typeof manager?.getProxySettings !== "function") {
    return undefined;
  }
  try {
    return normalizeRuntimeProxy(await manager.getProxySettings());
  } catch {
    // A proxy lookup must not make an otherwise usable Codex session fail.
    // Keep the Gateway service environment as the compatibility fallback.
    return undefined;
  }
}

function normalizeRuntimeProxy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rawProxy = typeof value.httpsProxy === "string" ? value.httpsProxy.trim() : "";
  if (rawProxy) {
    let parsed;
    try {
      parsed = new URL(rawProxy);
    } catch {
      return undefined;
    }
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
      return undefined;
    }
  }
  return {
    httpsProxy: rawProxy || undefined,
    noProxy: typeof value.noProxy === "string" ? value.noProxy.trim() : undefined
  };
}

function applyRuntimeProxy(environment, settings) {
  for (const key of [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"
  ]) {
    delete environment[key];
  }
  if (settings.httpsProxy) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      environment[key] = settings.httpsProxy;
    }
  }
  const noProxy = mergeNoProxy(settings.noProxy);
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
}

function mergeNoProxy(value) {
  const entries = new Set(
    typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : []
  );
  for (const entry of ["127.0.0.1", "localhost", "::1"]) {
    entries.add(entry);
  }
  return [...entries].join(",");
}

async function resolveRuntimeProvider(manager, emit) {
  if (typeof manager?.getCodexExecProviderConfig !== "function") {
    return undefined;
  }
  try {
    return normalizeCodexExecProviderConfig(await manager.getCodexExecProviderConfig());
  } catch (error) {
    if (!canUseSharedCodexCliFallback(error)) {
      throw error;
    }
    // The Manager's resident hot-switch adapter is optional for the ordinary
    // ChatGPT route. The Gateway process already shares the same CODEX_HOME
    // and executable, so a missing adapter must not make an otherwise usable
    // Codex CLI session fail before it starts.
    emit?.({
      type: "provider.runtime_fallback",
      message: "Manager Codex adapter unavailable; using the shared Codex CLI credentials"
    });
    return undefined;
  }
}

function canUseSharedCodexCliFallback(error) {
  if (error?.code === "manager_provider_unavailable") {
    return true;
  }
  return typeof error?.statusCode === "number" && error.statusCode >= 500 && error.statusCode <= 599;
}

function normalizeCodexExecProviderConfig(value) {
  if (
    !value ||
    typeof value.baseUrl !== "string" ||
    typeof value.token !== "string" ||
    typeof value.model !== "string" ||
    (value.route !== "gateway" && value.route !== "chatgpt") ||
    value.ready !== true
  ) {
    throw new GatewayProviderError("Manager Codex provider route is unavailable", "manager_provider_unavailable");
  }
  return {
    baseUrl: value.baseUrl,
    token: value.token,
    model: value.model,
    route: value.route,
    ready: true,
    instanceId: value.instanceId
  };
}

function buildRuntimeProviderArgs(provider) {
  const providerId = "codex-accounts-manager-runtime";
  const providerConfig =
    `model_providers.${providerId}={ name="Manager", base_url=${tomlString(provider.baseUrl)}, ` +
    'env_key="CODEX_ACCOUNTS_GATEWAY_ADAPTER_TOKEN", wire_api="responses", ' +
    "requires_openai_auth=false, supports_websockets=false }";
  // The configured model belongs to the external Gateway route. When the
  // Manager adapter is on the ChatGPT route, reusing that name can make an
  // otherwise valid Codex account reject the request (for example, `gpt-5`
  // is not a supported ChatGPT Codex model). Let Codex use the model from the
  // shared CODEX_HOME for that route; resume also keeps its thread model.
  const modelArgs = provider.route === "gateway"
    ? ["--config", `model=${tomlString(provider.model)}`]
    : [];
  return [
    "--config",
    `model_provider="${providerId}"`,
    ...modelArgs,
    "--config",
    providerConfig
  ];
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildSemanticResumePrompt(session) {
  const turns = Array.isArray(session.turns)
    ? session.turns
        .slice(-8)
        .map((turn) => {
          const result = typeof turn?.result?.text === "string" ? turn.result.text : "";
          return `用户：${turn?.message ?? ""}${result ? `\n助手：${result}` : ""}`;
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
  return [
    "请继续执行下面的原始任务。原 Codex thread 无法跨账号恢复，因此这是一个新的 session；不要重复已经完成的工作。",
    session.context?.fastWorkbench === true ? fastWorkbenchInstructions() : workbenchInstructions(),
    turns ? `此前对话：\n${turns}` : `当前任务：${session.message}`,
    "请先检查当前 worktree 状态，再从未完成的步骤继续。"
  ].join("\n\n");
}

function runCodexProcess({ binary, args, cwd, env, timeoutSeconds, modelHint, emit, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let finalResponse = "";
    let threadId;
    let quotaDetected = false;
    let settled = false;
    let turnCompleted = false;
    let postTurnGrace;
    let usage;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(postTurnGrace);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const terminateChild = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    };
    const settleCompletedTurn = () => {
      if (!turnCompleted || settled) {
        return;
      }
      if (quotaDetected) {
        finish(reject, new QuotaExhaustionError("Codex quota exhausted", { threadId, usage }));
        terminateChild();
        return;
      }
      const complete = () => {
        finish(resolve, { threadId, text: finalResponse, usage });
        terminateChild();
      };
      // Codex normally emits item.completed before turn.completed. Keep a
      // short grace period for clients that flush the final agent message
      // immediately after the turn event, then terminate the lingering exec.
      if (finalResponse) {
        complete();
      } else if (!postTurnGrace) {
        postTurnGrace = setTimeout(complete, 250);
      }
    };
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    child.on("error", (error) => {
      finish(reject, new GatewayProviderError(`无法启动 Codex：${error.message}`, "spawn_failed"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
      if (isQuotaText(chunk)) {
        quotaDetected = true;
      }
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        emit({ type: "codex.output", text: line });
        return;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalResponse = typeof event.item.text === "string" ? event.item.text : finalResponse;
      }
      if (event.type === "turn.completed") {
        usage = normalizeTokenUsage(event.usage ?? event.response?.usage, event.model ?? modelHint) ?? usage;
      }
      quotaDetected ||= isQuotaEvent(event);
      emit({ type: "codex.event", event });
      if (event.type === "turn.completed") {
        turnCompleted = true;
      }
      settleCompletedTurn();
    });

    child.once("close", (exitCode, signalName) => {
      lines.close();
      if (signal?.aborted) {
        finish(reject, new SessionCancelledError());
        return;
      }
      if (quotaDetected) {
        finish(reject, new QuotaExhaustionError("Codex quota exhausted", { threadId, usage }));
        return;
      }
      if (exitCode !== 0) {
        const detail = stderr.trim();
        finish(
          reject,
          new GatewayProviderError(
            `Codex 退出码 ${exitCode ?? "unknown"}${signalName ? `（${signalName}）` : ""}${detail ? `：${detail}` : ""}`,
            "codex_failed"
          )
        );
        return;
      }
      finish(resolve, { threadId, text: finalResponse, usage });
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutSeconds * 1_000);
    timeout.unref();
  });
}

function createOpenAiCompatibleProvider(config) {
  return {
    async run({ session, emit, signal }) {
      const endpoint = `${config.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
      const headers = {
        accept: "text/event-stream, application/json",
        "content-type": "application/json"
      };
      if (config.apiKey) {
        headers.authorization = `Bearer ${config.apiKey}`;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: config.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: buildResearchMessages(session)
        })
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2_000);
        throw new GatewayProviderError(`研究 provider 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`, "research_failed");
      }
      if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") !== true) {
        const body = await response.json();
        const text = extractAssistantText(body);
        emit({ type: "provider.completed", text });
        return { text, usage: normalizeTokenUsage(body?.usage, config.model) };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let usage;
      const processLine = (line) => {
        if (!line.startsWith("data:")) {
          return;
        }
        const raw = line.slice("data:".length).trim();
        if (raw === "[DONE]") {
          return;
        }
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        usage = normalizeTokenUsage(event?.usage ?? event?.response?.usage, config.model) ?? usage;
        const delta = textContent(event.choices?.[0]?.delta?.content);
        if (delta) {
          text += delta;
          emit({ type: "provider.delta", text: delta });
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
        if (done) {
          processLine(buffer);
          break;
        }
      }
      emit({ type: "provider.completed", text });
      return { text, usage };
    }
  };
}

function extractAssistantText(body) {
  return textContent(body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text);
}

function buildResearchMessages(session) {
  const messages = [{ role: "system", content: "你是 Research Workbench 的研究助手。" }];
  const turns = Array.isArray(session.turns) ? session.turns : [];
  if (turns.length > 0) {
    for (const turn of turns) {
      if (typeof turn?.message !== "string" || !turn.message.trim()) continue;
      messages.push({ role: "user", content: turn.message });
      const result = textContent(turn.result?.text);
      if (result) messages.push({ role: "assistant", content: result });
    }
    return messages;
  }
  const history = historyPrompt(session);
  if (history) messages.push({ role: "system", content: history });
  messages.push({ role: "user", content: session.message });
  return messages;
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => textContent(item?.text ?? item?.content ?? item)).filter(Boolean).join("");
  }
  if (value && typeof value === "object") {
    return textContent(value.text ?? value.content);
  }
  return "";
}

function buildInitialPrompt(session) {
  const history = historyPrompt(session);
  const task = history ? `${history}\n\n当前任务：\n${session.message}` : session.message;
  const instructions = session.context?.fastWorkbench === true
    ? fastWorkbenchInstructions(session.context)
    : workbenchInstructions();
  return `${instructions}\n\n${task}`;
}

function fastWorkbenchInstructions(context = {}) {
  if (fastWorkbenchAgents === undefined) {
    try {
      fastWorkbenchAgents = readFileSync(FAST_WORKBENCH_AGENTS_URL, "utf8").trim();
    } catch {
      fastWorkbenchAgents = [
        "这是简单的只读 Workbench 查询。不要读取仓库源码或 AGENTS.md。",
        "直接使用 WORKBENCH_DATA_URL 的 /api/workbench/records HTTP API；不要调用写入接口。",
        "返回简洁中文结果。"
      ].join("\n");
    }
  }
  const hint = [context.fastWorkbenchKind, context.fastWorkbenchDate].filter(Boolean).join("，");
  return `${fastWorkbenchAgents}${hint ? `\n本次快速查询提示：${hint}。` : ""}`;
}

function workbenchInstructions() {
  return [
    "如果当前项目是 Research Workbench，请先阅读仓库根目录 AGENTS.md 和 macos/AGENTS.md。",
    "Workbench 数据由独立的数据服务持有，不由 Manager Gateway 持有；不要直接打开或修改 SQLite 文件。",
    "查询或写入 Workbench 记录、日程和其它数据时，使用环境变量 WORKBENCH_DATA_URL（未注入时默认 http://127.0.0.1:43119）提供的 /api/workbench/* HTTP API；若注入 WORKBENCH_DATA_TOKEN，则以 Bearer 令牌请求且绝不回显令牌；写入后重新查询验证。",
    "当前 Gateway 是单用户受控服务，Codex exec 已获准使用宿主机完整访问权限；因此可以直接访问本机回环数据服务、检查进程/端口和调用必要的本机服务命令。",
    "只有用户明确要求时才写入或删除数据；日期使用 YYYY-MM-DD，时间使用 HH:mm。"
  ].join("\n");
}

function historyPrompt(session) {
  const history = session.context?.history;
  if (!Array.isArray(history) || history.length === 0) return "";
  const lines = history
    .filter((item) => item && typeof item.content === "string")
    .slice(-8)
    .map((item, index) => {
      const result = typeof item.result === "string" ? item.result : "";
      return `历史 ${index + 1}：${item.content}${result ? `\n结果：${result}` : ""}`;
    });
  return lines.length > 0 ? `仅来自当前模式的历史上下文：\n${lines.join("\n\n")}` : "";
}

function isQuotaEvent(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  const errorValues = [];
  if (event.type === "error" || event.type === "turn.failed" || event.type === "item.failed") {
    errorValues.push(event);
  }
  if (event.error !== undefined) {
    errorValues.push(event.error);
  }
  if (event.item && typeof event.item === "object" && (event.item.type === "error" || event.item.error !== undefined)) {
    errorValues.push(event.item);
  }
  if (event.payload && typeof event.payload === "object" && (event.payload.type === "error" || event.payload.error !== undefined)) {
    errorValues.push(event.payload);
  }
  return errorValues.some((value) => containsQuotaErrorMarker(value));
}

function isQuotaText(value) {
  return containsQuotaErrorMarker(value);
}

function containsQuotaErrorMarker(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/[’‘]/gu, "'");
    return [
      "quota_exhausted",
      "api_key_quota_exhausted",
      "quota exhausted",
      "usage_limit_reached",
      "usage_limit_exceeded",
      "you've hit your usage limit",
      "you have hit your usage limit",
      "usage limit exceeded",
      "usage limit reached",
      "no_available_account",
      "no_available_accounts",
      "insufficient_balance",
      "限额已用尽",
      "额度耗尽",
      "额度已用完"
    ].some((marker) => normalized.includes(marker));
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).some((entry) => containsQuotaErrorMarker(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return false;
  }
  return ["code", "type", "message", "detail", "error", "data", "codexErrorInfo", "codex_error_info", "errorInfo", "error_info"].some(
    (key) => containsQuotaErrorMarker(value[key], depth + 1)
  );
}
