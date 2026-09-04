import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { WorktreeManager } from "../src/worktree-manager.mjs";

const execFileAsync = promisify(execFile);

describe("WorktreeManager", () => {
  it("keeps develop changes isolated and applies tracked plus new files explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "manager-gateway-worktree-"));
    const stateDir = join(root, ".gateway-state");
    try {
      await execFileAsync("git", ["init", "-q", root]);
      await writeFile(join(root, "tracked.txt"), "before\n");
      await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
      await execFileAsync("git", [
        "-C", root,
        "-c", "user.name=Gateway Test",
        "-c", "user.email=gateway-test@example.com",
        "commit", "-q", "-m", "initial"
      ]);

      const manager = new WorktreeManager({ projectRoot: root, stateDir });
      const workspace = await manager.prepare({ id: "session-1" });
      await writeFile(join(workspace.cwd, "tracked.txt"), "after\n");
      await writeFile(join(workspace.cwd, "new.txt"), "created\n");

      const diff = await manager.collectDiff(workspace);
      assert.match(diff, /tracked\.txt/u);
      assert.match(diff, /new\.txt/u);

      const applied = await manager.apply(workspace);
      assert.equal(applied.status, "applied");
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "after\n");
      assert.equal(await readFile(join(root, "new.txt"), "utf8"), "created\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
