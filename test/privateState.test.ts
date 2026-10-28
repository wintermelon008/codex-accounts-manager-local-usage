import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateStateScaffold,
  getPrivateStatePaths,
  migrateLegacyGlobalStorage,
  resolvePrivateStateRoot,
  PRIVATE_STATE_FILE_NAMES
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
          extensionUri: { fsPath: "/installed/extensions/wintermelon.codex-account-manager-0.1.19-dev" },
          globalStorageUri: { fsPath: "/installed/data/User/globalStorage/wintermelon.codex-account-manager" }
        },
        {}
      )
    ).toBe("/installed/data/User/globalStorage/wintermelon.codex-account-manager");
  });

  it("moves legacy global storage into the fork-specific extension ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-id-migration-"));
    const globalStorage = path.join(root, "globalStorage");
    const legacyRoot = path.join(globalStorage, "wannanbigpig.codex-accounts-manager");
    const currentRoot = path.join(globalStorage, "wintermelon.codex-account-manager");
    try {
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(path.join(legacyRoot, "accounts-index.json"), "legacy-state\n");

      await migrateLegacyGlobalStorage(
        {
          extensionUri: { fsPath: "/installed/extensions/wintermelon.codex-account-manager-0.1.19-dev" },
          globalStorageUri: { fsPath: currentRoot }
        },
        {}
      );

      await expect(readFile(path.join(currentRoot, "accounts-index.json"), "utf8")).resolves.toBe("legacy-state\n");
      await expect(readFile(path.join(legacyRoot, "accounts-index.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips legacy migration after canonical Manager state is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-id-migration-current-"));
    const globalStorage = path.join(root, "globalStorage");
    const legacyRoot = path.join(globalStorage, "wannanbigpig.codex-accounts-manager");
    const currentRoot = path.join(globalStorage, "wintermelon.codex-account-manager");
    try {
      await mkdir(legacyRoot, { recursive: true });
      await mkdir(currentRoot, { recursive: true });
      await writeFile(path.join(legacyRoot, "accounts-index.json"), "legacy-state\n");
      await writeFile(path.join(currentRoot, PRIVATE_STATE_FILE_NAMES.hostState), "not-json\n");

      await migrateLegacyGlobalStorage(
        {
          extensionUri: { fsPath: "/installed/extensions/wintermelon.codex-account-manager-0.1.21-l4" },
          globalStorageUri: { fsPath: currentRoot }
        },
        {}
      );

      await expect(readFile(path.join(currentRoot, PRIVATE_STATE_FILE_NAMES.hostState), "utf8")).resolves.toBe(
        "not-json\n"
      );
      await expect(readFile(path.join(legacyRoot, "accounts-index.json"), "utf8")).resolves.toBe("legacy-state\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent first migrations idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-id-migration-concurrent-"));
    const globalStorage = path.join(root, "globalStorage");
    const legacyRoot = path.join(globalStorage, "wannanbigpig.codex-accounts-manager");
    const currentRoot = path.join(globalStorage, "wintermelon.codex-account-manager");
    const context = {
      extensionUri: { fsPath: "/installed/extensions/wintermelon.codex-account-manager-0.1.21-l4" },
      globalStorageUri: { fsPath: currentRoot }
    };
    try {
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(path.join(legacyRoot, PRIVATE_STATE_FILE_NAMES.accountsIndex), "legacy-state\n");

      const results = await Promise.allSettled([
        migrateLegacyGlobalStorage(context, {}),
        migrateLegacyGlobalStorage(context, {})
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      await expect(
        readFile(path.join(currentRoot, PRIVATE_STATE_FILE_NAMES.accountsIndex), "utf8")
      ).resolves.toBe("legacy-state\n");
      await expect(readFile(path.join(legacyRoot, PRIVATE_STATE_FILE_NAMES.accountsIndex), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readdir(globalStorage)).resolves.not.toContain(
        ".wintermelon.codex-account-manager-migration.lease"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a non-empty new global storage directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-id-migration-conflict-"));
    const globalStorage = path.join(root, "globalStorage");
    const legacyRoot = path.join(globalStorage, "wannanbigpig.codex-accounts-manager");
    const currentRoot = path.join(globalStorage, "wintermelon.codex-account-manager");
    try {
      await mkdir(legacyRoot, { recursive: true });
      await mkdir(currentRoot, { recursive: true });
      await writeFile(path.join(legacyRoot, "legacy.txt"), "legacy\n");
      await writeFile(path.join(currentRoot, "current.txt"), "current\n");

      await expect(
        migrateLegacyGlobalStorage(
          {
            extensionUri: { fsPath: "/installed/extensions/wintermelon.codex-account-manager-0.1.19-dev" },
            globalStorageUri: { fsPath: currentRoot }
          },
          {}
        )
      ).rejects.toThrow("new directory is not empty");

      await expect(readFile(path.join(legacyRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy\n");
      await expect(readFile(path.join(currentRoot, "current.txt"), "utf8")).resolves.toBe("current\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
