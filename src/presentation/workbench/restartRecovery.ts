import type { ExtensionContext } from "vscode";
import type { CodexIndexHealthStatus } from "../../core/types";

export const PENDING_RESTART_RECOVERY_KEY = "codexAccounts.restartRecovery.pending.v1";
export const LAST_RESTART_RECOVERY_KEY = "codexAccounts.restartRecovery.last.v1";
export const RESTART_RECOVERY_MAX_AGE_MS = 10 * 60 * 1000;

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const;

export type RestartRecoveryMarker = {
  version: 1;
  requestedAt: number;
};

export type RestartRecoveryCheckName = "accountsIndex" | "managerControl" | "codexRuntime";
export type RestartRecoveryCheckStatus = "passed" | "warning" | "failed" | "skipped";
export type RestartRecoveryStatus = "passed" | "degraded" | "failed";

export type RestartRecoveryCheck = {
  name: RestartRecoveryCheckName;
  status: RestartRecoveryCheckStatus;
  detail: string;
  attempts?: number;
};

export type RestartRecoveryReport = {
  status: RestartRecoveryStatus;
  requestedAt: number;
  checkedAt: number;
  durationMs: number;
  checks: RestartRecoveryCheck[];
};

export type RestartRecoveryProbe = {
  readIndexHealth: () => Promise<{ status: CodexIndexHealthStatus }>;
  managerControlEnabled: boolean;
  managerControlReady: () => boolean;
  runtimeEnabled: boolean;
  readRuntimeStatus: () => Promise<{ ready: boolean }>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  probeTimeoutMs?: number;
};

export async function markRestartRecoveryRequested(
  context: ExtensionContext,
  requestedAt = Date.now()
): Promise<RestartRecoveryMarker> {
  const marker: RestartRecoveryMarker = {
    version: 1,
    requestedAt: Math.floor(requestedAt)
  };
  await context.globalState.update(PENDING_RESTART_RECOVERY_KEY, marker);
  return marker;
}

export async function clearPendingRestartRecovery(context: ExtensionContext): Promise<void> {
  await context.globalState.update(PENDING_RESTART_RECOVERY_KEY, undefined);
}

export async function readPendingRestartRecovery(
  context: ExtensionContext,
  now = Date.now()
): Promise<RestartRecoveryMarker | undefined> {
  const value = context.globalState.get<unknown>(PENDING_RESTART_RECOVERY_KEY);
  const marker = parseRestartRecoveryMarker(value);
  if (!marker) {
    if (value !== undefined) {
      await clearPendingRestartRecovery(context);
    }
    return undefined;
  }

  if (now - marker.requestedAt > RESTART_RECOVERY_MAX_AGE_MS) {
    await clearPendingRestartRecovery(context);
    return undefined;
  }

  return marker;
}

export async function saveRestartRecoveryReport(
  context: ExtensionContext,
  report: RestartRecoveryReport
): Promise<void> {
  try {
    await context.globalState.update(LAST_RESTART_RECOVERY_KEY, report);
  } finally {
    await clearPendingRestartRecovery(context);
  }
}

export async function runRestartRecoveryCheck(
  requestedAt: number,
  probe: RestartRecoveryProbe
): Promise<RestartRecoveryReport> {
  const now = probe.now ?? Date.now;
  const startedAt = now();
  const checks: RestartRecoveryCheck[] = [];

  checks.push(await checkAccountsIndex(probe.readIndexHealth));

  if (!probe.managerControlEnabled) {
    checks.push({
      name: "managerControl",
      status: "skipped",
      detail: "Control API disabled"
    });
  } else {
    checks.push(
      await checkEventually(
        "managerControl",
        () => probe.managerControlReady(),
        "Control API listening",
        "Control API is not listening",
        probe
      )
    );
  }

  if (!probe.runtimeEnabled) {
    checks.push({
      name: "codexRuntime",
      status: "skipped",
      detail: "Codex Runtime disabled"
    });
  } else {
    checks.push(
      await checkEventually(
        "codexRuntime",
        async () => (await probe.readRuntimeStatus()).ready,
        "Codex Runtime ready",
        "Codex Runtime did not become ready",
        probe,
        probe.probeTimeoutMs
      )
    );
  }

  const checkedAt = now();
  const failed = checks.some((check) => check.status === "failed");
  const warning = checks.some((check) => check.status === "warning");

  return {
    status: failed ? "failed" : warning ? "degraded" : "passed",
    requestedAt,
    checkedAt,
    durationMs: Math.max(0, checkedAt - startedAt),
    checks
  };
}

export function formatRestartRecoveryReport(report: RestartRecoveryReport, language: string): string {
  const isChinese = language === "zh" || language === "zh-hant";
  const labels: Record<RestartRecoveryCheckName, string> = isChinese
    ? {
        accountsIndex: "账号索引",
        managerControl: "Control API",
        codexRuntime: "Codex Runtime"
      }
    : {
        accountsIndex: "account index",
        managerControl: "Control API",
        codexRuntime: "Codex Runtime"
      };
  const states: Record<RestartRecoveryCheckStatus, string> = isChinese
    ? {
        passed: "正常",
        warning: "待恢复",
        failed: "失败",
        skipped: "已禁用"
      }
    : {
        passed: "ready",
        warning: "recovering",
        failed: "failed",
        skipped: "disabled"
      };
  const checks = report.checks
    .map((check) => `${labels[check.name]} ${states[check.status]}`)
    .join(isChinese ? "，" : ", ");

  if (isChinese) {
    return report.status === "passed"
      ? `Manager 重启完成：${checks}。`
      : `Manager 已重启，但恢复检查未完全通过：${checks}。`;
  }

  return report.status === "passed"
    ? `Manager restart completed: ${checks}.`
    : `Manager restarted, but recovery checks are not fully ready: ${checks}.`;
}

async function checkAccountsIndex(
  readIndexHealth: RestartRecoveryProbe["readIndexHealth"]
): Promise<RestartRecoveryCheck> {
  try {
    const summary = await readIndexHealth();
    if (summary.status === "healthy") {
      return { name: "accountsIndex", status: "passed", detail: "Account index healthy" };
    }
    if (summary.status === "restored_from_backup") {
      return {
        name: "accountsIndex",
        status: "warning",
        detail: "Account index restored from backup"
      };
    }
    return {
      name: "accountsIndex",
      status: "failed",
      detail: "Account index is unavailable"
    };
  } catch {
    return {
      name: "accountsIndex",
      status: "failed",
      detail: "Account index health check failed"
    };
  }
}

async function checkEventually(
  name: Exclude<RestartRecoveryCheckName, "accountsIndex">,
  probe: () => boolean | Promise<boolean>,
  passedDetail: string,
  failedDetail: string,
  options: RestartRecoveryProbe,
  probeTimeoutMs?: number
): Promise<RestartRecoveryCheck> {
  const delays = normalizeRetryDelays(options.retryDelaysMs);
  const sleep = options.sleep ?? defaultSleep;
  let probeFailed = false;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = delays[attempt] ?? 0;
    if (delay > 0) {
      await sleep(delay);
    }
    try {
      if (await runWithTimeout(probe(), probeTimeoutMs ?? 3_000)) {
        return {
          name,
          status: "passed",
          detail: passedDetail,
          attempts: attempt + 1
        };
      }
    } catch {
      probeFailed = true;
    }
  }

  return {
    name,
    status: name === "codexRuntime" ? "failed" : "warning",
    detail: probeFailed ? `${name} status probe failed` : failedDetail,
    attempts: delays.length
  };
}

function normalizeRetryDelays(delays: readonly number[] | undefined): readonly number[] {
  if (!delays || delays.length === 0) {
    return DEFAULT_RETRY_DELAYS_MS;
  }
  return delays.map((delay) => (Number.isFinite(delay) && delay > 0 ? delay : 0));
}

function parseRestartRecoveryMarker(value: unknown): RestartRecoveryMarker | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as { version?: unknown; requestedAt?: unknown };
  if (candidate.version !== 1 || typeof candidate.requestedAt !== "number" || !Number.isFinite(candidate.requestedAt)) {
    return undefined;
  }
  return {
    version: 1,
    requestedAt: Math.floor(candidate.requestedAt)
  };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runWithTimeout(probe: boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await probe;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(probe),
      new Promise<boolean>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("restart recovery probe timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
