"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolvePrivateStateRoot } = require("../src/private-state.cjs");
const { resolveTotpConfigFilePath } = require("../src/totp/manager.cjs");

test("Mailbox and 2FAuth resolve into the configured Manager private root", () => {
  const root = "/srv/manager/private";
  assert.equal(
    resolvePrivateStateRoot({ storageUri: { fsPath: "/legacy/global-storage" }, env: {
      CODEX_ACCOUNTS_PRIVATE_DIR: root
    } }),
    root
  );
  assert.equal(resolveTotpConfigFilePath({ privateRoot: root }), `${root}/mailbox-2fauth.json`);
});

test("Mailbox uses the source checkout private directory during extension development", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-manager-mailbox-checkout-"));
  try {
    await fs.mkdir(path.join(root, "private"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "private", "README.md"), "layout\n");
    await fs.writeFile(path.join(root, "src", "extension.ts"), "export {};\n");
    assert.equal(
      resolvePrivateStateRoot({
        storageUri: { fsPath: "/work/globalStorage/codex-accounts.codex-accounts-mailbox" },
        managerExtensionRoot: root,
        env: {}
      }),
      path.join(root, "private")
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Mailbox does not use the replaceable installed Manager extension", () => {
  assert.equal(
    resolvePrivateStateRoot({
      storageUri: { fsPath: "/installed/data/User/globalStorage/codex-accounts.codex-accounts-mailbox" },
      managerExtensionRoot: "/installed/extensions/wannanbigpig.codex-accounts-manager-0.1.19-dev",
      env: {}
    }),
    "/installed/data/User/globalStorage/wannanbigpig.codex-accounts-manager"
  );
});

test("Mailbox rejects a relative private root", () => {
  assert.throws(
    () => resolvePrivateStateRoot({ storageUri: { fsPath: "/legacy/global-storage" }, env: {
      CODEX_ACCOUNTS_PRIVATE_DIR: "private"
    } }),
    /must be an absolute private directory/u
  );
});
