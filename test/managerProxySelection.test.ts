import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getManagerProxySelectionPath,
  readManagerProxySelection,
  writeManagerProxySelection
} from "../src/infrastructure/config/managerProxySelection";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createPrivateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-manager-proxy-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("shared Manager proxy selection", () => {
  it("round-trips the Dashboard selection atomically", async () => {
    const root = await createPrivateRoot();

    await writeManagerProxySelection(root, " http://127.0.0.1:7897 ");

    await expect(readManagerProxySelection(root)).resolves.toBe("http://127.0.0.1:7897");
    await expect(readFile(getManagerProxySelectionPath(root), "utf8")).resolves.toContain(
      '"schema":"codex-accounts-manager-proxy-selection/v1"'
    );
    await expect(stat(getManagerProxySelectionPath(root))).resolves.toMatchObject({ mode: 0o100600 });
  });

  it("uses no override for the empty Dashboard option", async () => {
    const root = await createPrivateRoot();

    await writeManagerProxySelection(root, "");

    await expect(readManagerProxySelection(root)).resolves.toBeUndefined();
  });

  it("ignores malformed or unsupported state instead of breaking the daemon", async () => {
    const root = await createPrivateRoot();
    const selection = getManagerProxySelectionPath(root);

    await writeFile(selection, "not-json", "utf8");
    await expect(readManagerProxySelection(root)).resolves.toBeUndefined();

    await writeFile(
      selection,
      JSON.stringify({ schema: "codex-accounts-manager-proxy-selection/v1", httpsProxy: "socks5://127.0.0.1:7897" }),
      "utf8"
    );
    await expect(readManagerProxySelection(root)).resolves.toBeUndefined();
  });
});
