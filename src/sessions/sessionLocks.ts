import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCodexHome } from "../codex/authFile";

const execFileAsync = promisify(execFile);
const SESSION_LOCK_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/u;
const PROCESS_COMMAND_TIMEOUT_MS = 2_000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_TERMINATION_POLL_INTERVAL_MS = 25;
const PROCESS_TERMINATION_TIMEOUT_MS = 1_000;

export type CodexSessionLockCleanupResult = {
  removedSessionIds: string[];
  terminatedSessionIds: string[];
  activeSessionIds: string[];
};

export type CodexSessionLockCleanupOptions = {
  /** Processes belonging to the Extension Host that owns the Dashboard. */
  currentWindowProcessIds?: ReadonlySet<number>;
};

/**
 * Remove UUID-named Codex thread locks and terminate other-window Codex
 * app-server processes that still hold them.
 *
 * The current window is identified by the process tree rooted at this
 * Extension Host. Only a process holding the specific lock, identified as a
 * Codex app-server, is eligible for termination. Unknown holders and the
 * current window remain reported as active.
 */
export async function clearStaleCodexSessionLocks(
  codexHome = getCodexHome(),
  options: CodexSessionLockCleanupOptions = {}
): Promise<CodexSessionLockCleanupResult> {
  const lockDirectory = path.join(codexHome, "thread-writer-locks");
  let entries: Dirent[];
  try {
    entries = await readdir(lockDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removedSessionIds: [], terminatedSessionIds: [], activeSessionIds: [] };
    }
    throw error;
  }

  const lockNames = entries
    .filter((entry) => entry.isFile() && SESSION_LOCK_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removedSessionIds: string[] = [];
  const terminatedSessionIds: string[] = [];
  const activeSessionIds: string[] = [];
  let currentWindowProcessIds = options.currentWindowProcessIds;
  let currentWindowProcessDiscoveryAttempted = options.currentWindowProcessIds !== undefined;

  for (const lockName of lockNames) {
    const lockPath = path.join(lockDirectory, lockName);
    const sessionId = lockName.slice(0, -".lock".length);
    if (await removeIfUnlocked(lockPath)) {
      removedSessionIds.push(sessionId);
      continue;
    }

    if (!currentWindowProcessDiscoveryAttempted) {
      currentWindowProcessDiscoveryAttempted = true;
      currentWindowProcessIds = await discoverCurrentWindowProcessIds(process.pid);
    }

    if (
      currentWindowProcessIds &&
      (await terminateOtherCodexLockHolders(lockPath, currentWindowProcessIds)) &&
      (await removeIfUnlocked(lockPath))
    ) {
      terminatedSessionIds.push(sessionId);
      continue;
    }

    // A holder may have exited between the first probe and process lookup.
    if (await removeIfUnlocked(lockPath)) {
      removedSessionIds.push(sessionId);
      continue;
    }

    activeSessionIds.push(sessionId);
  }

  return { removedSessionIds, terminatedSessionIds, activeSessionIds };
}

async function terminateOtherCodexLockHolders(
  lockPath: string,
  currentWindowProcessIds: ReadonlySet<number>
): Promise<boolean> {
  const holderPids = await findLockHolderPids(lockPath);
  let terminated = false;

  for (const pid of holderPids) {
    if (currentWindowProcessIds.has(pid)) {
      continue;
    }

    const command = await readProcessCommand(pid);
    if (!command || !isCodexRuntimeCommand(command)) {
      continue;
    }

    if (await terminateProcess(pid)) {
      terminated = true;
    }
  }

  return terminated;
}

async function findLockHolderPids(lockPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-t", "-w", "--", lockPath], {
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024
    });
    return parseProcessIds(stdout);
  } catch (error) {
    // lsof uses exit code 1 when the file has no open descriptors. A missing
    // or unavailable process inspector is fail-closed: the lock is reported
    // as active instead of guessing which process should be terminated.
    if (getExitCode(error) === 1 || getErrorCode(error) === "ENOENT") {
      return [];
    }
    return [];
  }
}

function parseProcessIds(output: string): number[] {
  return [
    ...new Set(
      output
        .trim()
        .split(/\s+/u)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    )
  ];
}

async function readProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isCodexRuntimeCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  const hasCodexExecutable = /(?:^|[\s/])codex(?:[.\w-]*)(?:\s|$)/u.test(normalized);
  const hasAppServerArgument = /(?:^|\s)app-server(?:\s|$)/u.test(normalized);
  return hasCodexExecutable && hasAppServerArgument;
}

async function discoverCurrentWindowProcessIds(rootPid: number): Promise<Set<number> | undefined> {
  const parentByPid = await readProcessParentMap(rootPid);
  if (!parentByPid) {
    return undefined;
  }

  const processIds = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parentByPid) {
      if (!processIds.has(pid) && processIds.has(parentPid)) {
        processIds.add(pid);
        changed = true;
      }
    }
  }
  return processIds;
}

async function readProcessParentMap(rootPid: number): Promise<Map<number, number> | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-e", "-o", "pid=", "-o", "ppid="], {
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024
    });
    const parentByPid = new Map<number, number>();
    for (const line of stdout.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (match) {
        parentByPid.set(Number(match[1]), Number(match[2]));
      }
    }
    return parentByPid.has(rootPid) ? parentByPid : undefined;
  } catch {
    return undefined;
  }
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return getErrorCode(error) === "ESRCH";
  }

  if (await waitForProcessExit(pid, PROCESS_TERMINATION_GRACE_MS)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (getErrorCode(error) !== "ESRCH") {
      return false;
    }
  }
  return waitForProcessExit(pid, PROCESS_TERMINATION_TIMEOUT_MS);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROCESS_TERMINATION_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== "ESRCH";
  }
}

async function removeIfUnlocked(lockPath: string): Promise<boolean> {
  try {
    const unlinkScript =
      "const fs = require('node:fs'); try { fs.unlinkSync(process.argv[1]); } catch (error) { if (error?.code !== 'ENOENT') throw error; }";
    await execFileAsync(
      "flock",
      [
        "--nonblock",
        "--exclusive",
        lockPath,
        "--command",
        `${shellQuote(process.execPath)} -e ${shellQuote(unlinkScript)} ${shellQuote(lockPath)}`
      ],
      { timeout: 5_000 }
    );
    return true;
  } catch (error) {
    if (getExitCode(error) === 1) {
      return false;
    }
    throw new Error(`Unable to inspect Codex session lock '${lockPath}'`, { cause: error });
  }
}

function getExitCode(error: unknown): number | undefined {
  const code = getErrorCode(error);
  return typeof code === "number" ? code : typeof code === "string" && /^\d+$/u.test(code) ? Number(code) : undefined;
}

function getErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
