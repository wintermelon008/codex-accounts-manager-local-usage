"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SESSION_SCHEMA = 1;

class AdminSessionStateError extends Error {
  constructor() {
    super("The private Sub2API administrator session state is unavailable.");
    this.name = "AdminSessionStateError";
  }
}

async function readRefreshToken(stateFile, options = {}) {
  if (!stateFile) return undefined;
  const fsImpl = options.fsImpl ?? fs;
  let info;
  try {
    info = await fsImpl.lstat(stateFile);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new AdminSessionStateError();
  }
  if (!isSafePrivateFile(info)) {
    throw new AdminSessionStateError();
  }
  let value;
  try {
    value = JSON.parse(await fsImpl.readFile(stateFile, "utf8"));
  } catch {
    throw new AdminSessionStateError();
  }
  const token = value?.schema === SESSION_SCHEMA ? nonemptyString(value.refresh_token) : undefined;
  if (!token) {
    throw new AdminSessionStateError();
  }
  return token;
}

async function writeRefreshToken(stateFile, refreshToken, options = {}) {
  if (!stateFile || !nonemptyString(refreshToken)) {
    throw new AdminSessionStateError();
  }
  const fsImpl = options.fsImpl ?? fs;
  const randomUuid = options.randomUuid ?? crypto.randomUUID;
  const directory = path.dirname(stateFile);
  if (directory === path.parse(directory).root) {
    throw new AdminSessionStateError();
  }
  await ensurePrivateDirectory(directory, fsImpl);
  await assertSafeTarget(stateFile, fsImpl);
  const temporary = path.join(directory, `.${path.basename(stateFile)}.${randomUuid()}.tmp`);
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify({ schema: SESSION_SCHEMA, refresh_token: refreshToken })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await fsImpl.rename(temporary, stateFile);
    await fsImpl.chmod(stateFile, 0o600).catch(() => undefined);
  } catch {
    throw new AdminSessionStateError();
  } finally {
    await fsImpl.unlink(temporary).catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory, fsImpl) {
  try {
    await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fsImpl.lstat(directory);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
      throw new Error("unsafe directory");
    }
    await fsImpl.chmod(directory, 0o700).catch(() => undefined);
  } catch (error) {
    if (error instanceof AdminSessionStateError) throw error;
    throw new AdminSessionStateError();
  }
}

async function assertSafeTarget(target, fsImpl) {
  try {
    const info = await fsImpl.lstat(target);
    if (!isSafePrivateFile(info)) throw new AdminSessionStateError();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof AdminSessionStateError) throw error;
    throw new AdminSessionStateError();
  }
}

function isSafePrivateFile(info) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (
    info?.isFile?.() &&
    !info.isSymbolicLink?.() &&
    (currentUid === undefined || info.uid === currentUid) &&
    (Number(info.mode) & 0o077) === 0
  );
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

module.exports = { AdminSessionStateError, readRefreshToken, writeRefreshToken };
