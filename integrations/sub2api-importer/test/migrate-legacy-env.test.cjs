"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { migrateLegacyEnvironment } = require("../scripts/migrate-legacy-env.cjs");

test("migrates only the required legacy Sub2API values into a new private importer environment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-env-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "legacy.env");
  const destinationPath = path.join(root, "new", "importer.env");
  await fs.writeFile(
    sourcePath,
    [
      "FEISHU_APP_SECRET=must-not-copy",
      "SUB2API_BASE_URL=https://gateway.example.invalid/",
      "SUB2API_ADMIN_API_KEY=private-admin-api-key",
      "SUB2API_IMPORT_GROUP_NAME=test",
      "SUB2API_IMPORT_CONCURRENCY=2",
      "SHOP_TOKEN=must-not-copy"
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  const result = await migrateLegacyEnvironment({ sourcePath, destinationPath, pollSeconds: "9" });
  const created = await fs.readFile(destinationPath, "utf8");
  assert.deepEqual(result, { destinationPath, pollSeconds: 9 });
  assert.match(created, /^SUB2API_ADMIN_BASE_URL=https:\/\/gateway\.example\.invalid$/mu);
  assert.match(created, /^SUB2API_ADMIN_API_KEY=private-admin-api-key$/mu);
  assert.match(created, /^SUB2API_IMPORT_PROXY_NAME=default$/mu);
  assert.match(created, /^SUB2API_IMPORT_GROUP_NAME=test$/mu);
  assert.match(created, /^SUB2API_IMPORT_CONCURRENCY=2$/mu);
  assert.match(created, /^SUB2API_IMPORT_POLL_SECONDS=9$/mu);
  assert.doesNotMatch(created, /FEISHU_APP_SECRET|SHOP_TOKEN|must-not-copy/u);
  assert.equal((await fs.stat(destinationPath)).mode & 0o777, 0o600);
});

test("refuses to overwrite a private destination environment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-env-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "legacy.env");
  const destinationPath = path.join(root, "importer.env");
  await fs.writeFile(sourcePath, "SUB2API_BASE_URL=https://gateway.example.invalid\nSUB2API_ADMIN_API_KEY=private-admin-api-key\n", { mode: 0o600 });
  await fs.writeFile(destinationPath, "keep-existing\n", { mode: 0o600 });
  await assert.rejects(
    () => migrateLegacyEnvironment({ sourcePath, destinationPath }),
    /already exists/u
  );
});
