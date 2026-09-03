import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCodexHome } from "../codex/authFile";

const execFileAsync = promisify(execFile);
const SESSION_LOCK_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/u;

export type CodexSessionLockCleanupResult = {
  removedSessionIds: string[];
  activeSessionIds: string[];
};

/**
 * Remove only UUID-named Codex thread locks that are not currently held.
 *
 * Codex uses an advisory flock on these files. The flock command keeps the
 * lock while it removes an unheld path, so an active writer is never treated
 * as a stale file and is left untouched.
 */
export async function clearStaleCodexSessionLocks(codexHome = getCodexHome()): Promise<CodexSessionLockCleanupResult> {
  const lockDirectory = path.join(codexHome, "thread-writer-locks");
  let entries: Dirent[];
  try {
    entries = await readdir(lockDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removedSessionIds: [], activeSessionIds: [] };
    }
    throw error;
  }

  const lockNames = entries
    .filter((entry) => entry.isFile() && SESSION_LOCK_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removedSessionIds: string[] = [];
  const activeSessionIds: string[] = [];

  for (const lockName of lockNames) {
    const lockPath = path.join(lockDirectory, lockName);
    if (await removeIfUnlocked(lockPath)) {
      removedSessionIds.push(lockName.slice(0, -".lock".length));
    } else {
      activeSessionIds.push(lockName.slice(0, -".lock".length));
    }
  }

  return { removedSessionIds, activeSessionIds };
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
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : typeof code === "string" && /^\d+$/u.test(code) ? Number(code) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
