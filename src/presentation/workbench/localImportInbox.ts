import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SharedCodexAccountJson } from "../../core/types";
import type { AccountsRepository } from "../../storage";
import { importSharedAccountsIntoBalancePool } from "../../application/accounts/importIntoBalancePool";

export const LOCAL_IMPORT_POLL_INTERVAL_MS = 3_000;
const LOCAL_IMPORT_LEASE_MS = 2 * 60 * 1000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_JOB_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNTS_PER_JOB = 50;
const IMPORT_JOB_SCHEMA = "codex-account-import/v1";
const IMPORT_RESULT_SCHEMA = "codex-account-import-result/v1";
const JOB_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JOB_FILE_PATTERN = new RegExp(`^(${JOB_ID_PATTERN})\\.json$`);
const PROCESSING_FILE_PATTERN = new RegExp(`^(${JOB_ID_PATTERN})\\.processing$`);

type LocalImportJob = {
  schema: typeof IMPORT_JOB_SCHEMA;
  id: string;
  created_at: string;
  accounts: SharedCodexAccountJson[];
};

type LocalImportResult = {
  schema: typeof IMPORT_RESULT_SCHEMA;
  id: string;
  status: "completed" | "partial" | "failed";
  processed_at: string;
  total: number;
  imported: number;
  pool_enabled: number;
  refresh_failed: number;
  not_eligible: number;
  auth_failed: number;
  import_failed: number;
};

export type LocalImportInboxOptions = {
  queuePath?: string;
  pollIntervalMs?: number;
};

/**
 * Consume private local jobs produced by the Feishu command bot.
 *
 * Credentials are read only in the extension host so AccountsRepository can
 * store them in VS Code SecretStorage.  Results are intentionally redacted:
 * they contain counters only, never account identities or token material.
 */
export class LocalImportInbox {
  private readonly queuePath: string;
  private readonly resultsPath: string;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;
  private disposed = false;

  constructor(
    private readonly repo: AccountsRepository,
    private readonly onProcessed: () => void,
    options: LocalImportInboxOptions = {}
  ) {
    this.queuePath = options.queuePath ?? getLocalImportInboxPath();
    this.resultsPath = path.join(path.dirname(this.queuePath), "results");
    this.pollIntervalMs = options.pollIntervalMs ?? LOCAL_IMPORT_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.ensureDirectories();
    void this.processPendingJobs();
    this.timer = setInterval(() => {
      void this.processPendingJobs();
    }, this.pollIntervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async processPendingJobs(): Promise<void> {
    if (this.disposed || this.processing) {
      return;
    }
    this.processing = true;
    try {
      await this.ensureDirectories();
      const lease = await this.repo.tryAcquireSchedulerLease("local-import-inbox", LOCAL_IMPORT_LEASE_MS);
      if (!lease) {
        return;
      }
      try {
        await this.requeueStaleProcessingJobs();
        const claimed = await this.claimNextJob();
        if (claimed) {
          await this.processClaimedJob(claimed.id, claimed.path);
        }
      } finally {
        await lease.release();
      }
    } catch (error) {
      console.warn("[codexAccounts] local import inbox is unavailable:", describeLocalError(error));
    } finally {
      this.processing = false;
    }
  }

  private async ensureDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.queuePath);
    await ensurePrivateDirectory(this.resultsPath);
  }

  private async requeueStaleProcessingJobs(): Promise<void> {
    const entries = await fs.readdir(this.queuePath, { withFileTypes: true });
    const cutoff = Date.now() - STALE_PROCESSING_MS;
    for (const entry of entries) {
      const match = PROCESSING_FILE_PATTERN.exec(entry.name);
      if (!match?.[1] || !entry.isFile()) {
        continue;
      }
      const processingPath = path.join(this.queuePath, entry.name);
      const info = await safeLstat(processingPath);
      if (!info || !info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) {
        continue;
      }
      const pendingPath = path.join(this.queuePath, `${match[1]}.json`);
      if (await pathExists(pendingPath)) {
        continue;
      }
      await fs.rename(processingPath, pendingPath).catch(() => undefined);
    }
  }

  private async claimNextJob(): Promise<{ id: string; path: string } | undefined> {
    const entries = await fs.readdir(this.queuePath, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const match = JOB_FILE_PATTERN.exec(name);
      if (!match?.[1]) {
        continue;
      }
      const jobId = match[1];
      const pendingPath = path.join(this.queuePath, name);
      const info = await safeLstat(pendingPath);
      if (!info || !info.isFile() || info.isSymbolicLink()) {
        continue;
      }
      const resultPath = path.join(this.resultsPath, `${jobId}.json`);
      if (await pathExists(resultPath)) {
        await fs.unlink(pendingPath).catch(() => undefined);
        continue;
      }
      const processingPath = path.join(this.queuePath, `${jobId}.processing`);
      try {
        await fs.rename(pendingPath, processingPath);
        return { id: jobId, path: processingPath };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async processClaimedJob(jobId: string, jobPath: string): Promise<void> {
    let result: LocalImportResult;
    try {
      const job = await readLocalImportJob(jobPath, jobId);
      result = await this.importAccounts(job);
    } catch {
      result = failedResult(jobId, 0, 1);
    }

    try {
      await writeResult(path.join(this.resultsPath, `${jobId}.json`), result);
    } catch (error) {
      console.warn("[codexAccounts] could not write local import result:", describeLocalError(error));
    } finally {
      await fs.unlink(jobPath).catch(() => undefined);
      this.onProcessed();
    }
  }

  private async importAccounts(job: LocalImportJob): Promise<LocalImportResult> {
    const summary = await importSharedAccountsIntoBalancePool(this.repo, job.accounts);
    return {
      schema: IMPORT_RESULT_SCHEMA,
      id: job.id,
      status: summary.status,
      processed_at: new Date().toISOString(),
      total: summary.total,
      imported: summary.imported,
      pool_enabled: summary.poolEnabled,
      refresh_failed: summary.refreshFailed,
      not_eligible: summary.notEligible,
      auth_failed: summary.authFailed,
      import_failed: summary.importFailed
    };
  }
}

export function getLocalImportInboxPath(): string {
  const managerQueuePath = process.env["MANAGER_IMPORT_QUEUE_DIR"]?.trim();
  const configured =
    managerQueuePath && managerQueuePath.length > 0 ? managerQueuePath : process.env["CODEX_IMPORT_QUEUE_DIR"]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("local import queue path must be absolute");
    }
    return path.normalize(configured);
  }
  const configuredStateHome = process.env["XDG_STATE_HOME"]?.trim();
  const stateHome =
    configuredStateHome && path.isAbsolute(configuredStateHome)
      ? configuredStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "codex-account-import", "inbox");
}

async function readLocalImportJob(jobPath: string, expectedId: string): Promise<LocalImportJob> {
  const info = await safeLstat(jobPath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_JOB_BYTES) {
    throw new Error("invalid local import job file");
  }
  const raw = await fs.readFile(jobPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isLocalImportJob(parsed, expectedId)) {
    throw new Error("invalid local import job payload");
  }
  return parsed;
}

function isLocalImportJob(value: unknown, expectedId: string): value is LocalImportJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["schema"] === IMPORT_JOB_SCHEMA &&
    record["id"] === expectedId &&
    typeof record["created_at"] === "string" &&
    Array.isArray(record["accounts"]) &&
    record["accounts"].length > 0 &&
    record["accounts"].length <= MAX_ACCOUNTS_PER_JOB &&
    record["accounts"].every((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
  );
}

function failedResult(jobId: string, total: number, importFailed: number): LocalImportResult {
  return {
    schema: IMPORT_RESULT_SCHEMA,
    id: jobId,
    status: "failed",
    processed_at: new Date().toISOString(),
    total,
    imported: 0,
    pool_enabled: 0,
    refresh_failed: 0,
    not_eligible: 0,
    auth_failed: 0,
    import_failed: importFailed
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new Error("unsafe local import directory");
  }
  await fs.chmod(directory, 0o700);
}

async function writeResult(target: string, value: LocalImportResult): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function safeLstat(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  return Boolean(await safeLstat(target));
}

function describeLocalError(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown";
}
