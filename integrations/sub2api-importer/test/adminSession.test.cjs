"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AdminSessionStateError, readRefreshToken, writeRefreshToken } = require("../src/adminSession.cjs");

test("stores a rotated private refresh token in an owner-only state file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-admin-session-"));
  const target = path.join(directory, "session.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeRefreshToken(target, "rotated-private-refresh-token", { randomUuid: () => "test" });
  assert.equal(await readRefreshToken(target), "rotated-private-refresh-token");
  const info = await fs.stat(target);
  assert.equal(info.mode & 0o077, 0);
});

test("rejects an unsafe session state file instead of reading its contents", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-admin-session-"));
  const target = path.join(directory, "session.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(target, JSON.stringify({ schema: 1, refresh_token: "not-used" }), { mode: 0o644 });
  await fs.chmod(target, 0o644);
  await assert.rejects(readRefreshToken(target), AdminSessionStateError);
});

test("does not allow a state file to make the filesystem root private", async () => {
  await assert.rejects(writeRefreshToken("/session.json", "not-written"), AdminSessionStateError);
});
