import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStaleCodexSessionLocks } from "../src/sessions/sessionLocks";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Codex session locks", () => {
  it("removes stale UUID locks without touching unrelated files", async () => {
    const codexHome = await createCodexHome();
    const lockDirectory = path.join(codexHome, "thread-writer-locks");
    const staleLock = path.join(lockDirectory, "01a06256-dab8-7dc3-aa3e-4a20a2ada949.lock");
    await writeFile(staleLock, "");
    await writeFile(path.join(lockDirectory, ".coordination.lock"), "");
    await writeFile(path.join(lockDirectory, "not-a-session.lock"), "");

    await expect(clearStaleCodexSessionLocks(codexHome)).resolves.toEqual({
      removedSessionIds: ["01a06256-dab8-7dc3-aa3e-4a20a2ada949"],
      activeSessionIds: []
    });
    await expect(access(staleLock)).rejects.toThrow();
    await expect(access(path.join(lockDirectory, ".coordination.lock"))).resolves.toBeUndefined();
    await expect(access(path.join(lockDirectory, "not-a-session.lock"))).resolves.toBeUndefined();
  });

  it("leaves a lock held by another process untouched", async () => {
    const codexHome = await createCodexHome();
    const lockDirectory = path.join(codexHome, "thread-writer-locks");
    const lockPath = path.join(lockDirectory, "01a061dd-2043-7f30-b991-2dccb4feb7cd.lock");
    const readyPath = path.join(codexHome, "writer-ready");
    await writeFile(lockPath, "");

    const writer = spawn("flock", ["--exclusive", lockPath, "--command", `touch ${shellQuote(readyPath)}; sleep 5`], {
      stdio: "ignore"
    });
    try {
      await waitForFile(readyPath);
      await expect(clearStaleCodexSessionLocks(codexHome)).resolves.toEqual({
        removedSessionIds: [],
        activeSessionIds: ["01a061dd-2043-7f30-b991-2dccb4feb7cd"]
      });
      await expect(access(lockPath)).resolves.toBeUndefined();
    } finally {
      if (writer.exitCode === null) {
        writer.kill("SIGTERM");
        await once(writer, "exit");
      }
    }
  });
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-session-locks-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "thread-writer-locks"), { recursive: true });
  return root;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
