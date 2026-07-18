import * as fs from "node:fs/promises";
import * as path from "node:path";

const BACKUP_SUFFIX = ".codex-accounts-manager-original";

export type RemoteCliOverlay = {
  cliPath: string;
  realCliPath: string;
  launcherPath: string;
  installed: boolean;
};

/**
 * Replaces the remote Codex extension's bundled CLI with a symlink to the
 * manager launcher. The original binary remains alongside it and is used by
 * the launcher as the real app-server executable.
 */
export async function installRemoteCliOverlay(cliPath: string, launcherPath: string): Promise<RemoteCliOverlay> {
  const backupPath = `${cliPath}${BACKUP_SUFFIX}`;
  const normalizedLauncherPath = path.resolve(launcherPath);
  const entry = await fs.lstat(cliPath);

  if (entry.isSymbolicLink()) {
    const target = await fs.readlink(cliPath);
    if (path.resolve(path.dirname(cliPath), target) !== normalizedLauncherPath) {
      throw new Error(
        "Refusing to replace the remote Codex CLI because it is already a symbolic link managed by something else"
      );
    }
    await fs.access(backupPath);
    return { cliPath, realCliPath: backupPath, launcherPath: normalizedLauncherPath, installed: false };
  }

  if (!entry.isFile()) {
    throw new Error("The remote Codex CLI is not a regular executable file");
  }

  try {
    await fs.access(backupPath);
    throw new Error(
      "A previous Codex Accounts CLI backup already exists; remove the runtime first or restore that backup before installing again"
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      // Expected on the first installation.
    } else {
      throw error;
    }
  }

  await fs.rename(cliPath, backupPath);
  try {
    await fs.symlink(normalizedLauncherPath, cliPath);
  } catch (error) {
    await fs.rename(backupPath, cliPath).catch(() => undefined);
    throw error;
  }
  return { cliPath, realCliPath: backupPath, launcherPath: normalizedLauncherPath, installed: true };
}

/** Restores the bundled CLI only when the current overlay is ours. */
export async function restoreRemoteCliOverlay(cliPath: string, launcherPath: string): Promise<boolean> {
  const backupPath = `${cliPath}${BACKUP_SUFFIX}`;
  const normalizedLauncherPath = path.resolve(launcherPath);
  let entry: import("node:fs").Stats;
  try {
    entry = await fs.lstat(cliPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }

  const target = await fs.readlink(cliPath);
  if (path.resolve(path.dirname(cliPath), target) !== normalizedLauncherPath) {
    return false;
  }
  await fs.access(backupPath);
  await fs.unlink(cliPath);
  try {
    await fs.rename(backupPath, cliPath);
  } catch (error) {
    await fs.symlink(normalizedLauncherPath, cliPath).catch(() => undefined);
    throw error;
  }
  return true;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
