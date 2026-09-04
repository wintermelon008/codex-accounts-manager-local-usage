import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  CodexAccountRecord,
  CodexAdditionalQuotaLimit,
  CodexQuotaSummary,
  SharedCodexAccountJson
} from "../core/types";
import { isSub2ApiAccount } from "../core/types";
import { getErrorMessage } from "../core/errors";
import { getBalanceQuotaCapability, type BalanceQuotaCapability } from "../application/accounts/balanceScheduler";
import { getQuotaIssueKind } from "../utils/quotaIssue";
import type { AccountsRepository } from "../storage";
import type { CodexExecProviderConfig, RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome } from "../codex";
import { SessionHub, type SessionKind, type SessionListFilter, type SessionRegistration, type SessionStatus } from "../sessions";
import { normalizeLocalImportAccounts } from "./localImportProtocol";
import type { LocalUsageAnalyticsService } from "../services/localUsageAnalytics";
import type { DashboardLocalUsageDayModelViewModel, DashboardLocalUsageTokenTotals } from "../domain/dashboard/types";

const CONTROL_HOST = "127.0.0.1";
const CONTROL_API_PREFIX = "/api/manager";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_IMPORT_REQUEST_BYTES = 2 * 1024 * 1024;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ManagerControlHealth = "healthy" | "auth" | "quota" | "disabled";

export type ManagerControlQuotaWindow = {
  percentage?: number;
  resetAt?: number;
  requestsLeft?: number;
  requestsLimit?: number;
  windowMinutes?: number;
  present?: boolean;
};

export type ManagerControlAccount = {
  id: string;
  email: string;
  displayName: string;
  accountKind: "chatgpt" | "sub2api";
  manualOnly: boolean;
  providerActive: boolean;
  planType?: string;
  tags: string[];
  accountGroup?: CodexAccountRecord["accountGroup"];
  isActive: boolean;
  isHidden: boolean;
  balancePoolEnabled: boolean;
  poolCapability: BalanceQuotaCapability;
  poolEligible: boolean;
  health: ManagerControlHealth;
  lastQuotaAt?: number;
  quotaErrorCode?: string;
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
  quota: {
    hourly?: ManagerControlQuotaWindow;
    weekly?: ManagerControlQuotaWindow;
    codeReview?: ManagerControlQuotaWindow;
    additional: Array<{
      name: string;
      hourly?: ManagerControlQuotaWindow;
      weekly?: ManagerControlQuotaWindow;
    }>;
    credits?: {
      balance: string;
      unlimited: boolean;
      overageLimitReached: boolean;
    };
  };
};

export type ManagerControlAccountSummary = {
  generatedAt: number;
  counts: {
    total: number;
    visible: number;
    hidden: number;
    active: number;
    healthy: number;
    authFailed: number;
    quotaLimited: number;
    poolEnabled: number;
    poolEligible: number;
  };
  accounts: ManagerControlAccount[];
};

export type ManagerControlUsage = {
  status: "loading" | "ready" | "unavailable";
  isRefreshing: boolean;
  date: string;
  timeZone: string;
  calculatedAt?: number;
  nextRefreshAt?: number;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  byModel: Array<DashboardLocalUsageDayModelViewModel & { date: string }>;
};

export type ManagerControlImportStatus = {
  id: string;
  state: "queued" | "processing" | "completed" | "partial" | "failed" | "unknown";
  total?: number;
  imported?: number;
  poolEnabled?: number;
  refreshFailed?: number;
  notEligible?: number;
  authFailed?: number;
  importFailed?: number;
};

export type ManagerControlRefreshSummary = {
  total: number;
  succeeded: number;
  failed: number;
  unknownAccountIds: string[];
  failedAccountIds: string[];
};

export type ManagerControlJob = {
  id: string;
  type: "quota_refresh";
  state: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: ManagerControlRefreshSummary;
  error?: string;
};

export type ManagerControlSwitchOptions = Pick<RuntimeAccountSwitchOptions, "gracePeriodMs" | "longTurnPolicy"> & {
  force?: boolean;
};

export type ManagerControlServerOptions = {
  repo: Pick<AccountsRepository, "listAccounts">;
  usage: Pick<LocalUsageAnalyticsService, "getSnapshots">;
  sessionHub?: SessionHub;
  refreshQuotas: (accountIds?: readonly string[]) => Promise<ManagerControlRefreshSummary>;
  enqueueImport: (accounts: readonly SharedCodexAccountJson[]) => Promise<{ id: string; accountCount: number }>;
  getImportStatus: (jobId: string) => Promise<ManagerControlImportStatus>;
  switchAccount?: (
    accountId: string,
    options?: ManagerControlSwitchOptions
  ) => Promise<RuntimeAccountSwitchOutcome>;
  getCodexExecProviderConfig?: () => Promise<CodexExecProviderConfig>;
  now?: () => number;
};

export type ManagerControlServerAddress = {
  host: typeof CONTROL_HOST;
  port: number;
};

/**
 * Small loopback-only control surface for a separately running assistant.
 *
 * This server deliberately owns no credentials and does not expose the
 * Dashboard webview contract. The caller receives only a sanitized read model,
 * job counters, and allow-listed operations implemented by the workbench.
 */
export class ManagerControlServer {
  private server: Server | undefined;
  private token = "";
  private activeRefreshJobId: string | undefined;
  private readonly jobs = new Map<string, ManagerControlJob>();

  constructor(private readonly options: ManagerControlServerOptions) {}

  async start(port: number, token: string): Promise<ManagerControlServerAddress> {
    if (this.server) {
      throw new Error("Manager control server is already running");
    }
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new Error("Manager control token is required");
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("Manager control port must be an integer from 0 to 65535");
    }

    this.token = normalizedToken;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        console.warn("[codexAccounts] manager control request failed:", describeError(error));
        if (!response.headersSent) {
          sendJson(response, 500, { error: "manager control request failed" });
        } else {
          response.end();
        }
      });
    });
    this.server = server;

    try {
      await listen(server, CONTROL_HOST, port);
    } catch (error) {
      this.server = undefined;
      this.token = "";
      server.close(() => undefined);
      throw error;
    }

    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    return { host: CONTROL_HOST, port: actualPort };
  }

  dispose(): void {
    const server = this.server;
    this.server = undefined;
    this.token = "";
    this.activeRefreshJobId = undefined;
    this.jobs.clear();
    if (!server) {
      return;
    }
    server.close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        console.warn("[codexAccounts] manager control server close failed:", describeError(error));
      }
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request, this.token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${CONTROL_HOST}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "codex-accounts-manager", api: "manager-control" });
      return;
    }

    if (request.method === "GET" && url.pathname === `${CONTROL_API_PREFIX}/codex/provider-config`) {
      if (!this.options.getCodexExecProviderConfig) {
        sendJson(response, 503, { error: "Codex provider configuration is unavailable" });
        return;
      }
      sendJson(response, 200, await this.options.getCodexExecProviderConfig());
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/status` && request.method === "GET") {
      const [accounts, usageToday] = await Promise.all([this.readAccounts(), this.readUsageToday()]);
      sendJson(response, 200, { generatedAt: Date.now(), accounts, usageToday });
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/accounts` && request.method === "GET") {
      sendJson(response, 200, await this.readAccounts());
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/accounts/switch` && request.method === "POST") {
      if (!this.options.switchAccount) {
        sendJson(response, 503, { error: "account switching is unavailable" });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "switch request must be valid JSON and no larger than 16 KB" });
        return;
      }
      const accountId = parseAccountId(body);
      if (!accountId) {
        sendJson(response, 400, { error: "accountId is required" });
        return;
      }
      const force = isRecord(body) && body["force"] === true;
      const outcome = await this.options.switchAccount(accountId, {
        force,
        ...(force
          ? {
              gracePeriodMs: 0,
              longTurnPolicy: "interruptAndContinue"
            }
          : {})
      });
      if (outcome.status === "failed") {
        sendJson(response, 409, outcome);
        return;
      }
      sendJson(response, 200, outcome);
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/usage/today` && request.method === "GET") {
      sendJson(response, 200, await this.readUsageToday());
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/sessions` && request.method === "GET") {
      if (!this.options.sessionHub) {
        sendJson(response, 503, { error: "session hub unavailable" });
        return;
      }
      sendJson(response, 200, {
        generatedAt: Date.now(),
        sessions: await this.options.sessionHub.list(parseSessionListFilter(url.searchParams))
      });
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/sessions` && request.method === "POST") {
      if (!this.options.sessionHub) {
        sendJson(response, 503, { error: "session hub unavailable" });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "session registration must be valid JSON and no larger than 16 KB" });
        return;
      }
      const registration = parseSessionRegistration(body);
      if (!registration) {
        sendJson(response, 400, { error: "invalid session registration" });
        return;
      }
      sendJson(response, 201, await this.options.sessionHub.register(registration));
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/sessions/locate` && request.method === "GET") {
      if (!this.options.sessionHub) {
        sendJson(response, 503, { error: "session hub unavailable" });
        return;
      }
      const value = url.searchParams.get("value")?.trim();
      if (!value) {
        sendJson(response, 400, { error: "value is required" });
        return;
      }
      const session = await this.options.sessionHub.locate(value);
      if (!session) {
        sendJson(response, 404, { error: "session not found" });
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    const sessionMatch = new RegExp(`^${CONTROL_API_PREFIX}/sessions/([^/]+)$`, "u").exec(url.pathname);
    if (request.method === "GET" && sessionMatch?.[1]) {
      if (!this.options.sessionHub) {
        sendJson(response, 503, { error: "session hub unavailable" });
        return;
      }
      const conversationId = decodeURIComponent(sessionMatch[1]);
      const session = await this.options.sessionHub.get(conversationId);
      if (!session) {
        sendJson(response, 404, { error: "session not found" });
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/imports` && request.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(request, MAX_IMPORT_REQUEST_BYTES);
      } catch {
        sendJson(response, 400, { error: "import body must be valid JSON and no larger than 2 MB" });
        return;
      }
      if (!isRecord(body) || !Array.isArray(body["accounts"])) {
        sendJson(response, 400, { error: "accounts must be an array" });
        return;
      }
      let accounts: SharedCodexAccountJson[];
      try {
        accounts = normalizeLocalImportAccounts(body["accounts"]);
      } catch {
        sendJson(response, 400, { error: "accounts must contain 1-50 canonical OAuth entries" });
        return;
      }
      const queued = await this.options.enqueueImport(accounts);
      sendJson(response, 202, { id: queued.id, state: "queued", total: queued.accountCount });
      return;
    }

    const importMatch = new RegExp(`^${CONTROL_API_PREFIX}/imports/([^/]+)$`, "u").exec(url.pathname);
    if (request.method === "GET" && importMatch?.[1]) {
      let jobId: string;
      try {
        jobId = decodeURIComponent(importMatch[1]);
      } catch {
        sendJson(response, 400, { error: "invalid job id" });
        return;
      }
      if (!JOB_ID_PATTERN.test(jobId)) {
        sendJson(response, 400, { error: "invalid job id" });
        return;
      }
      sendJson(response, 200, await this.options.getImportStatus(jobId));
      return;
    }

    const jobMatch = new RegExp(`^${CONTROL_API_PREFIX}/jobs/([^/]+)$`, "u").exec(url.pathname);
    if (request.method === "GET" && jobMatch?.[1]) {
      const jobId = decodeURIComponent(jobMatch[1]);
      if (!JOB_ID_PATTERN.test(jobId)) {
        sendJson(response, 400, { error: "invalid job id" });
        return;
      }
      const job = this.jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: "job not found" });
        return;
      }
      sendJson(response, 200, job);
      return;
    }

    if (url.pathname === `${CONTROL_API_PREFIX}/quotas/refresh` && request.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "request body must be valid JSON and no larger than 16 KB" });
        return;
      }
      const accountIds = parseAccountIds(body);
      if (accountIds === "invalid") {
        sendJson(response, 400, { error: "accountIds must be an array of at most 100 strings" });
        return;
      }
      const job = this.startRefreshJob(accountIds);
      sendJson(response, 202, job);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  private async readAccounts(): Promise<ManagerControlAccountSummary> {
    const accounts = await this.options.repo.listAccounts();
    const mapped = accounts.map(mapAccount);
    const counts = mapped.reduce<ManagerControlAccountSummary["counts"]>(
      (summary, account) => {
        summary.total += 1;
        if (account.isHidden) {
          summary.hidden += 1;
        } else {
          summary.visible += 1;
        }
        if (account.isActive || account.providerActive) {
          summary.active += 1;
        }
        if (account.health === "healthy") {
          summary.healthy += 1;
        } else if (account.health === "auth") {
          summary.authFailed += 1;
        } else if (account.health === "quota") {
          summary.quotaLimited += 1;
        }
        if (account.balancePoolEnabled) {
          summary.poolEnabled += 1;
        }
        if (account.poolEligible) {
          summary.poolEligible += 1;
        }
        return summary;
      },
      {
        total: 0,
        visible: 0,
        hidden: 0,
        active: 0,
        healthy: 0,
        authFailed: 0,
        quotaLimited: 0,
        poolEnabled: 0,
        poolEligible: 0
      }
    );
    return { generatedAt: Date.now(), counts, accounts: mapped };
  }

  private async readUsageToday(): Promise<ManagerControlUsage> {
    const snapshots = await this.options.usage.getSnapshots();
    const localUsage = snapshots.localUsage;
    const date = currentDateInTimeZone(localUsage.timeZone, this.options.now?.() ?? Date.now());
    const today = localUsage.byDay.find((row) => row.date === date);
    const byModel = localUsage.byDayAndModel.filter((row) => row.date === date).map((row) => ({ ...row }));
    return {
      status: localUsage.status,
      isRefreshing: localUsage.isRefreshing,
      date,
      timeZone: localUsage.timeZone,
      calculatedAt: localUsage.calculatedAt,
      nextRefreshAt: localUsage.nextRefreshAt,
      eventCount: today?.eventCount ?? 0,
      total: today ? totalsFrom(today) : emptyTotals(),
      byModel
    };
  }

  private startRefreshJob(accountIds: readonly string[] | undefined): ManagerControlJob {
    this.pruneJobs();
    const activeJob = this.activeRefreshJobId ? this.jobs.get(this.activeRefreshJobId) : undefined;
    if (activeJob && (activeJob.state === "queued" || activeJob.state === "running")) {
      return activeJob;
    }

    const job: ManagerControlJob = {
      id: randomUUID(),
      type: "quota_refresh",
      state: "queued",
      createdAt: Date.now()
    };
    this.jobs.set(job.id, job);
    this.activeRefreshJobId = job.id;
    void this.runRefreshJob(job, accountIds);
    return job;
  }

  private async runRefreshJob(job: ManagerControlJob, accountIds: readonly string[] | undefined): Promise<void> {
    job.state = "running";
    try {
      job.result = await this.options.refreshQuotas(accountIds);
      job.state = "completed";
    } catch (error) {
      job.state = "failed";
      job.error = "quota refresh failed";
      console.warn("[codexAccounts] manager control quota refresh failed:", describeError(error));
    } finally {
      job.completedAt = Date.now();
      if (this.activeRefreshJobId === job.id) {
        this.activeRefreshJobId = undefined;
      }
    }
  }

  private pruneJobs(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (job.completedAt !== undefined && job.completedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

function mapAccount(account: CodexAccountRecord): ManagerControlAccount {
  const virtual = isSub2ApiAccount(account);
  const capability = virtual ? "unknown" : getBalanceQuotaCapability(account);
  const issueKind = virtual ? undefined : getQuotaIssueKind(account.quotaError);
  const health: ManagerControlHealth =
    issueKind === "disabled" ? "disabled" : issueKind === "auth" ? "auth" : issueKind === "quota" ? "quota" : "healthy";
  return {
    id: account.id,
    email: account.email,
    displayName: virtual
      ? (account.accountName?.trim() ?? "Sub2API Gateway")
      : (account.accountName?.trim() ?? account.email),
    accountKind: account.accountKind ?? "chatgpt",
    manualOnly: Boolean(account.manualOnly === true || virtual),
    providerActive: Boolean(account.providerActive),
    planType: account.planType,
    tags: [...(account.tags ?? [])],
    accountGroup: account.accountGroup,
    isActive: account.isActive,
    isHidden: Boolean(account.isHidden),
    balancePoolEnabled: Boolean(account.balancePoolEnabled),
    poolCapability: capability,
    poolEligible: !virtual && !account.isHidden && account.balancePoolEnabled === true && capability !== "unknown",
    health,
    lastQuotaAt: account.lastQuotaAt,
    quotaErrorCode: account.quotaError?.code,
    resetCreditsAvailable: account.quotaSummary?.resetCreditsAvailable,
    resetCreditsNextExpiresAt: account.quotaSummary?.resetCreditsNextExpiresAt,
    quota: {
      hourly: virtual ? undefined : mapQuotaWindow(account.quotaSummary, "hourly"),
      weekly: virtual ? undefined : mapQuotaWindow(account.quotaSummary, "weekly"),
      codeReview: virtual ? undefined : mapQuotaWindow(account.quotaSummary, "codeReview"),
      additional: virtual
        ? []
        : (account.quotaSummary?.additionalRateLimits ?? []).map((limit) => ({
            name: limit.limitName,
            hourly: mapQuotaWindow(limit, "hourly"),
            weekly: mapQuotaWindow(limit, "weekly")
          })),
      credits:
        virtual || !account.quotaSummary?.credits
          ? undefined
          : {
              balance: account.quotaSummary.credits.balance,
              unlimited: account.quotaSummary.credits.unlimited,
              overageLimitReached: account.quotaSummary.credits.overageLimitReached
            }
    }
  };
}

function mapQuotaWindow(
  quota: CodexQuotaSummary | CodexAdditionalQuotaLimit | undefined,
  kind: "hourly" | "weekly" | "codeReview"
): ManagerControlQuotaWindow | undefined {
  if (!quota) {
    return undefined;
  }
  const prefix = kind === "hourly" ? "hourly" : kind === "weekly" ? "weekly" : "codeReview";
  const value = quota[`${prefix}Percentage` as keyof typeof quota];
  const resetAt = quota[`${prefix}ResetTime` as keyof typeof quota];
  const requestsLeft = quota[`${prefix}RequestsLeft` as keyof typeof quota];
  const requestsLimit = quota[`${prefix}RequestsLimit` as keyof typeof quota];
  const windowMinutes = quota[`${prefix}WindowMinutes` as keyof typeof quota];
  const present = quota[`${prefix}WindowPresent` as keyof typeof quota];
  return {
    percentage: asFiniteNumber(value),
    resetAt: asFiniteNumber(resetAt),
    requestsLeft: asFiniteNumber(requestsLeft),
    requestsLimit: asFiniteNumber(requestsLimit),
    windowMinutes: asFiniteNumber(windowMinutes),
    present: typeof present === "boolean" ? present : undefined
  };
}

function totalsFrom(value: DashboardLocalUsageTokenTotals): DashboardLocalUsageTokenTotals {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens,
    totalTokens: value.totalTokens
  };
}

function emptyTotals(): DashboardLocalUsageTokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function currentDateInTimeZone(timeZone: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year") ?? "0000"}-${values.get("month") ?? "00"}-${values.get("day") ?? "00"}`;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAccountIds(body: unknown): readonly string[] | undefined | "invalid" {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (!isRecord(body)) {
    return "invalid";
  }
  const rawAccountIds = body["accountIds"];
  if (rawAccountIds === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawAccountIds) || rawAccountIds.length > 100) {
    return "invalid";
  }
  const accountIds = rawAccountIds.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return accountIds.length === rawAccountIds.length ? accountIds : "invalid";
}

function parseAccountId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const value = body["accountId"];
  return typeof value === "string" && value.trim() && value.trim().length <= 256 ? value.trim() : undefined;
}

function parseSessionListFilter(params: URLSearchParams): SessionListFilter {
  const kind = optionalText(params.get("kind"));
  const status = optionalText(params.get("status"));
  return {
    project: optionalText(params.get("project")),
    goalId: optionalText(params.get("goalId")),
    runId: optionalText(params.get("runId")),
    query: optionalText(params.get("query")),
    kind: isSessionKind(kind) ? kind : undefined,
    status: isSessionStatus(status) ? status : undefined
  };
}

function parseSessionRegistration(value: unknown): SessionRegistration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = optionalText(value["kind"]);
  const status = optionalText(value["status"]);
  const externalRefs = value["externalRefs"];
  if ((kind && !isSessionKind(kind)) || (status && !isSessionStatus(status))) {
    return undefined;
  }
  if (
    externalRefs !== undefined &&
    (!Array.isArray(externalRefs) || externalRefs.some((item) => typeof item !== "string"))
  ) {
    return undefined;
  }
  return {
    conversationId: optionalText(value["conversationId"]),
    kind: isSessionKind(kind) ? kind : undefined,
    project: optionalText(value["project"]),
    goalId: optionalText(value["goalId"]),
    runId: optionalText(value["runId"]),
    nativeThreadId: optionalText(value["nativeThreadId"]),
    title: optionalText(value["title"]),
    status: isSessionStatus(status) ? status : undefined,
    artifactLocator: optionalText(value["artifactLocator"]),
    externalRefs: externalRefs as string[] | undefined
  };
}

function isSessionKind(value: string | undefined): value is SessionKind {
  return value === "ordinary" || value === "supergoal" || value === "loop-goal";
}

function isSessionStatus(value: string | undefined): value is SessionStatus {
  return value === "active" || value === "idle" || value === "completed" || value === "blocked" || value === "unknown";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJsonBody(request: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(new Uint8Array(buffer));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

function isAuthorized(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  if (!expectedToken || typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  return safeEqual(authorization.slice("Bearer ".length).trim(), expectedToken);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded)
  });
  response.end(encoded);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return getErrorMessage(error);
}
