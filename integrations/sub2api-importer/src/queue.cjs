"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validatePayload } = require("./sub2apiClient.cjs");

const SUB2API_IMPORT_JOB_SCHEMA = "sub2api-import/v1";
const SUB2API_IMPORT_RESULT_SCHEMA = "sub2api-import-result/v1";
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_JOB_BYTES = 16 * 1024 * 1024;

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new Error("Sub2API import queue directory is unsafe.");
  }
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function claimNextJob(queueDirectory) {
  await ensurePrivateDirectory(queueDirectory);
  const names = (await fs.readdir(queueDirectory)).filter((name) => JOB_ID_PATTERN.test(name.replace(/\.json$/u, "")) && name.endsWith(".json")).sort();
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const queuedPath = path.join(queueDirectory, name);
    const processingPath = path.join(queueDirectory, `${id}.processing`);
    if (!(await isSafeJobFile(queuedPath))) continue;
    try {
      await fs.rename(queuedPath, processingPath);
      return { id, processingPath };
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "EEXIST")) continue;
      throw error;
    }
  }
  return undefined;
}

async function readClaimedJob(claim) {
  if (!(await isSafeJobFile(claim.processingPath))) {
    throw new Error("Sub2API import job is unsafe.");
  }
  let job;
  try {
    job = JSON.parse(await fs.readFile(claim.processingPath, "utf8"));
  } catch {
    throw new Error("Sub2API import job is invalid.");
  }
  if (!job || typeof job !== "object" || Array.isArray(job) || job.schema !== SUB2API_IMPORT_JOB_SCHEMA || job.id !== claim.id) {
    throw new Error("Sub2API import job schema is invalid.");
  }
  validatePayload(job.payload);
  return job;
}

async function writeResult(queueDirectory, result) {
  const resultDirectory = path.join(path.dirname(queueDirectory), "results");
  await ensurePrivateDirectory(resultDirectory);
  const target = path.join(resultDirectory, `${result.id}.json`);
  const temporary = path.join(resultDirectory, `.${result.id}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function completeClaim(claim) {
  await fs.unlink(claim.processingPath);
}

async function failClaim(claim) {
  const failedPath = claim.processingPath.replace(/\.processing$/u, ".failed");
  await fs.rename(claim.processingPath, failedPath).catch(async (error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function makeCompletedResult(job, result) {
  return {
    schema: SUB2API_IMPORT_RESULT_SCHEMA,
    id: job.id,
    status: "completed",
    completed_at: new Date().toISOString(),
    payload_accounts: job.payload.accounts.length,
    payload_proxies: job.payload.proxies.length,
    account_created: result.accountCreated,
    account_failed: result.accountFailed,
    ...(Number.isSafeInteger(result.accountConfigured) ? { account_configured: result.accountConfigured } : {}),
    proxy_created: result.proxyCreated,
    proxy_reused: result.proxyReused,
    proxy_failed: result.proxyFailed
  };
}

function makeFailedResult(job, error) {
  return {
    schema: SUB2API_IMPORT_RESULT_SCHEMA,
    id: job.id,
    status: "failed",
    completed_at: new Date().toISOString(),
    payload_accounts: Array.isArray(job?.payload?.accounts) ? job.payload.accounts.length : 0,
    payload_proxies: Array.isArray(job?.payload?.proxies) ? job.payload.proxies.length : 0,
    failure_kind:
      error?.kind === "remoteRejected" ||
      error?.kind === "invalidPayload" ||
      error?.kind === "invalidResponse" ||
      error?.kind === "tokenRefreshFailed" ||
      error?.kind === "sessionStateFailure" ||
      error?.kind === "configurationPreconditionFailed" ||
      error?.kind === "postImportConfigurationFailed"
        ? error.kind
        : "transportFailure",
    ...(Number.isInteger(error?.statusCode) ? { status_code: error.statusCode } : {})
  };
}

async function isSafeJobFile(target) {
  try {
    const info = await fs.lstat(target);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_JOB_BYTES && (currentUid === undefined || info.uid === currentUid);
  } catch {
    return false;
  }
}

module.exports = {
  SUB2API_IMPORT_JOB_SCHEMA,
  SUB2API_IMPORT_RESULT_SCHEMA,
  claimNextJob,
  completeClaim,
  ensurePrivateDirectory,
  failClaim,
  makeCompletedResult,
  makeFailedResult,
  readClaimedJob,
  writeResult
};
