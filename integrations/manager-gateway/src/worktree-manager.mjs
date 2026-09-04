import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 5_000_000;

export class WorktreeManager {
  #projectRoot;
  #stateDir;
  #execFile;

  constructor({ projectRoot, stateDir, execFileImpl = execFileAsync }) {
    this.#projectRoot = projectRoot;
    this.#stateDir = stateDir;
    this.#execFile = execFileImpl;
  }

  isAvailable() {
    return Boolean(this.#projectRoot);
  }

  async prepare(session) {
    if (session.workspace) return session.workspace;
    if (!this.#projectRoot) throw new Error("develop 模式未配置 MANAGER_GATEWAY_PROJECT_ROOT");
    const root = (await this.#git(["-C", this.#projectRoot, "rev-parse", "--show-toplevel"])).trim();
    const worktreeRoot = join(this.#stateDir, "worktrees");
    const worktreePath = join(worktreeRoot, session.id);
    await mkdir(worktreeRoot, { recursive: true });
    await this.#git(["-C", root, "worktree", "add", "--detach", worktreePath, "HEAD"]);
    return { kind: "git-worktree", id: session.id, root, cwd: worktreePath, status: "open", diff: "" };
  }

  async collectDiff(workspace) {
    const tracked = await this.#git(["-C", workspace.cwd, "diff", "--no-ext-diff", "--binary"], {
      maxBuffer: MAX_DIFF_BYTES
    });
    const untracked = await this.#git(["-C", workspace.cwd, "ls-files", "--others", "--exclude-standard", "-z"]);
    let additions = "";
    for (const file of untracked.split("\0").filter(Boolean)) {
      const patch = await this.#git(["-C", workspace.cwd, "diff", "--no-index", "--binary", "--", "/dev/null", file], {
        allowExitCodes: [1],
        maxBuffer: MAX_DIFF_BYTES
      });
      additions += patch;
      if (tracked.length + additions.length >= MAX_DIFF_BYTES) break;
    }
    return `${tracked}${additions}`.slice(0, MAX_DIFF_BYTES);
  }

  async apply(workspace) {
    const diff = await this.collectDiff(workspace);
    if (diff) {
      const directory = await mkdtemp(join(tmpdir(), "manager-gateway-apply-"));
      const patchPath = join(directory, "changes.patch");
      try {
        await writeFile(patchPath, diff, "utf8");
        await this.#git(["-C", workspace.root, "apply", "--binary", "--whitespace=nowarn", patchPath]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    await this.#remove(workspace);
    return { ...workspace, status: "applied", diff: "" };
  }

  async discard(workspace) {
    await this.#remove(workspace);
    return { ...workspace, status: "discarded", diff: "" };
  }

  async #remove(workspace) {
    await this.#git(["-C", workspace.root, "worktree", "remove", "--force", workspace.cwd]);
  }

  async #git(args, options = {}) {
    try {
      const result = await this.#execFile("git", args, {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 1_000_000
      });
      return typeof result?.stdout === "string" ? result.stdout : "";
    } catch (error) {
      if (options.allowExitCodes?.includes(error?.code) && typeof error?.stdout === "string") {
        return error.stdout;
      }
      throw error;
    }
  }
}
