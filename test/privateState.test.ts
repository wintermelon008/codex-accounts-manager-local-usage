import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateStateScaffold,
  getPrivateStatePaths,
  resolvePrivateStateRoot
} from "../src/storage/privateState";

describe("private state paths", () => {
  it("uses the explicit absolute directory for every private path", () => {
    const root = "/srv/manager/private";
    const paths = getPrivateStatePaths(undefined, { CODEX_ACCOUNTS_PRIVATE_DIR: root });

    expect(paths.root).toBe(root);
    expect(paths.accountsIndex).toBe(`${root}/accounts-index.json`);
    expect(paths.accountsSecrets).toBe(`${root}/accounts-secrets.v1.json`);
    expect(paths.latestSnapshot).toBe(`${root}/manager-state.latest.age`);
    expect(paths.importInbox).toBe(`${root}/import-inbox`);
    expect(paths.sessionRegistry).toBe(`${root}/session-registry.json`);
  });

  it("rejects a relative private directory", () => {
    expect(() => resolvePrivateStateRoot(undefined, { CODEX_ACCOUNTS_PRIVATE_DIR: "private" })).toThrow(
      "must be an absolute private directory"
    );
  });

  it("uses the extension checkout private directory when no override is set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-checkout-"));
    try {
      await mkdir(path.join(root, "private"));
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "private", "README.md"), "layout\n");
      await writeFile(path.join(root, "src", "extension.ts"), "export {};\n");
      expect(resolvePrivateStateRoot({ extensionUri: { fsPath: root } }, {})).toBe(
        path.join(root, "private")
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not use a replaceable installed extension directory", () => {
    expect(
      resolvePrivateStateRoot(
        {
          extensionUri: { fsPath: "/installed/extensions/wannanbigpig.codex-accounts-manager-0.1.19-dev" },
          globalStorageUri: { fsPath: "/installed/data/User/globalStorage/wannanbigpig.codex-accounts-manager" }
        },
        {}
      )
    ).toBe("/installed/data/User/globalStorage/wannanbigpig.codex-accounts-manager");
  });

  it("keeps storage-only test and legacy contexts compatible", () => {
    expect(resolvePrivateStateRoot({ globalStorageUri: { fsPath: "/tmp/manager-state" } }, {})).toBe(
      "/tmp/manager-state"
    );
  });

  it("creates host policy and state constraints without overwriting them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-private-scaffold-"));
    try {
      const paths = getPrivateStatePaths(undefined, { CODEX_ACCOUNTS_PRIVATE_DIR: root });
      await ensurePrivateStateScaffold(paths);
      const policy = JSON.parse(await readFile(paths.hostPolicy, "utf8"));
      const state = JSON.parse(await readFile(paths.hostState, "utf8"));
      expect(policy).toMatchObject({ promotion: "explicit", autoPromote: false, sync: { mode: "daily", hour: 0 } });
      expect(state).toMatchObject({ role: "uninitialized", epoch: 0, sequence: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
