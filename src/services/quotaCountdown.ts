import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CodexTokens } from "../core/types";
import { getCodexHome } from "../codex/authFile";
import { CODEX_API_BASE } from "../infrastructure/config/apiEndpoints";
import { logNetworkEvent } from "../utils/debug";
import { fetchWithTimeout } from "../utils/network";

const CODEX_RESPONSES_URL = `${CODEX_API_BASE}/backend-api/codex/responses`;
const RESPONSE_TIMEOUT_MS = 45_000;

type CodexModelDescriptor = {
  slug?: unknown;
  priority?: unknown;
  supported_in_api?: unknown;
  visibility?: unknown;
};

type QuotaCountdownDependencies = {
  loadModelCache?: () => Promise<unknown>;
  request?: typeof fetchWithTimeout;
};

export async function sendQuotaCountdownStartMessage(
  tokens: Pick<CodexTokens, "accessToken" | "accountId">,
  dependencies: QuotaCountdownDependencies = {}
): Promise<void> {
  if (!tokens.accessToken) {
    throw new Error("The selected account has no usable Codex access token");
  }
  if (!tokens.accountId) {
    throw new Error("The selected account has no ChatGPT workspace identifier");
  }

  const cache = await (dependencies.loadModelCache ?? loadCodexModelCache)();
  const model = selectQuotaCountdownModel(cache);
  if (!model) {
    throw new Error("No usable Codex model was found; open Codex once to refresh its model list");
  }

  const response = await (dependencies.request ?? fetchWithTimeout)(
    CODEX_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "ChatGPT-Account-Id": tokens.accountId,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify(buildQuotaCountdownRequest(model))
    },
    RESPONSE_TIMEOUT_MS,
    "Quota countdown starter"
  );

  const raw = await response.text();
  logNetworkEvent("quota.countdownStarter", {
    accountId: tokens.accountId,
    model,
    status: response.status,
    ok: response.ok
  });
  if (!response.ok) {
    throw new Error(`Codex rejected the countdown starter (${response.status}): ${extractResponseError(raw)}`);
  }

  assertQuotaCountdownResponseCompleted(raw);
}

export function buildQuotaCountdownRequest(model: string): Record<string, unknown> {
  return {
    model,
    instructions: "Reply only with OK.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hi" }]
      }
    ],
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "low" },
    store: false,
    stream: true,
    include: []
  };
}

export function selectQuotaCountdownModel(payload: unknown): string | undefined {
  const root = asRecord(payload);
  const candidates = Array.isArray(payload) ? payload : Array.isArray(root?.["models"]) ? root["models"] : [];
  const usable = candidates
    .map((candidate) => candidate as CodexModelDescriptor)
    .filter(
      (candidate): candidate is CodexModelDescriptor & { slug: string } =>
        typeof candidate.slug === "string" &&
        candidate.slug.trim().length > 0 &&
        candidate.supported_in_api !== false &&
        candidate.visibility !== "hide"
    )
    .sort((left, right) => normalizePriority(left.priority) - normalizePriority(right.priority));

  return usable.find((candidate) => /(?:luna|mini)/iu.test(candidate.slug))?.slug ?? usable[0]?.slug;
}

async function loadCodexModelCache(): Promise<unknown> {
  const raw = await fs.readFile(path.join(getCodexHome(), "models_cache.json"), "utf8");
  return JSON.parse(raw) as unknown;
}

function normalizePriority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function readResponseStatus(raw: string): string | undefined {
  try {
    const root = asRecord(JSON.parse(raw) as unknown);
    return typeof root?.["status"] === "string" ? root["status"] : undefined;
  } catch {
    return undefined;
  }
}

function assertQuotaCountdownResponseCompleted(raw: string): void {
  const jsonStatus = readResponseStatus(raw);
  if (jsonStatus === "completed") {
    return;
  }
  if (jsonStatus === "failed" || jsonStatus === "cancelled" || jsonStatus === "incomplete") {
    throw new Error(`Codex countdown starter ended with status ${jsonStatus}`);
  }

  let completed = false;
  for (const event of parseServerSentEvents(raw)) {
    if (event.data === "[DONE]") {
      continue;
    }

    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(event.data) as unknown);
    } catch {
      continue;
    }

    const type = typeof payload?.["type"] === "string" ? payload["type"] : event.name;
    if (type === "response.completed") {
      completed = true;
      continue;
    }
    if (type === "error" || type === "response.failed" || type === "response.cancelled") {
      throw new Error(`Codex countdown starter stream failed: ${extractStreamingError(payload, type)}`);
    }
    if (type === "response.incomplete") {
      throw new Error(`Codex countdown starter stream ended incomplete: ${extractStreamingError(payload, type)}`);
    }
  }

  if (!completed) {
    throw new Error("Codex countdown starter stream ended without a completion event");
  }
}

function parseServerSentEvents(raw: string): Array<{ name?: string; data: string }> {
  return raw
    .split(/\r?\n\r?\n/u)
    .map((block) => {
      let name: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith("event:")) {
          name = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice("data:".length).trimStart());
        }
      }
      return { name, data: data.join("\n") };
    })
    .filter((event) => event.data.length > 0);
}

function extractStreamingError(payload: Record<string, unknown> | undefined, fallback: string): string {
  const response = asRecord(payload?.["response"]);
  const error = asRecord(payload?.["error"]) ?? asRecord(response?.["error"]);
  const incomplete = asRecord(response?.["incomplete_details"]);
  const message = payload?.["message"] ?? error?.["message"] ?? incomplete?.["reason"];
  return typeof message === "string" && message.trim() ? message.slice(0, 240) : fallback;
}

function extractResponseError(raw: string): string {
  try {
    const root = asRecord(JSON.parse(raw) as unknown);
    const error = asRecord(root?.["error"]);
    const message = error?.["message"] ?? root?.["detail"];
    return typeof message === "string" && message.trim() ? message.slice(0, 240) : `HTTP response ${raw.slice(0, 120)}`;
  } catch {
    return raw.trim().slice(0, 240) || "empty response";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
