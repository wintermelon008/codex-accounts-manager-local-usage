import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installRemoteCliOverlay, restoreRemoteCliOverlay } from "../src/codex/remoteCliOverlay";

describe("remote Codex CLI overlay", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it("installs a reversible launcher symlink without modifying VS Code settings", async () => {
    const directory = await createTemporaryDirectory();
    const cliPath = path.join(directory, "bin", "codex");
    const launcherPath = path.join(directory, "runtime", "codex-app-server-shim");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(cliPath, "official-codex-binary", "utf8");
    await fs.chmod(cliPath, 0o755);
    await fs.writeFile(launcherPath, "manager-launcher", "utf8");

    const overlay = await installRemoteCliOverlay(cliPath, launcherPath);

    expect(overlay.installed).toBe(true);
    expect(await fs.readlink(cliPath)).toBe(path.resolve(launcherPath));
    await expect(fs.readFile(overlay.realCliPath, "utf8")).resolves.toBe("official-codex-binary");

    expect(await restoreRemoteCliOverlay(cliPath, launcherPath)).toBe(true);
    await expect(fs.readFile(cliPath, "utf8")).resolves.toBe("official-codex-binary");
    await expect(fs.access(overlay.realCliPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses its own overlay but refuses to replace a foreign symlink", async () => {
    const directory = await createTemporaryDirectory();
    const cliPath = path.join(directory, "codex");
    const launcherPath = path.join(directory, "runtime", "launcher");
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(cliPath, "official-codex-binary", "utf8");
    await fs.writeFile(launcherPath, "manager-launcher", "utf8");

    const first = await installRemoteCliOverlay(cliPath, launcherPath);
    const repeated = await installRemoteCliOverlay(cliPath, launcherPath);
    expect(first.installed).toBe(true);
    expect(repeated.installed).toBe(false);

    await restoreRemoteCliOverlay(cliPath, launcherPath);
    await fs.unlink(cliPath);
    await fs.symlink(path.join(directory, "another-launcher"), cliPath);
    await expect(installRemoteCliOverlay(cliPath, launcherPath)).rejects.toThrow(
      "symbolic link managed by something else"
    );
  });

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-accounts-overlay-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
