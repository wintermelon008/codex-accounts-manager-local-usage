#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeAdminBaseUrl } = require("../src/config.cjs");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await migrateLegacyEnvironment(options);
  process.stdout.write("Created private Sub2API importer configuration.\n");
}

async function migrateLegacyEnvironment(options) {
  const sourcePath = requireAbsolutePath(options.sourcePath, "--source");
  const destinationPath = requireAbsolutePath(options.destinationPath, "--destination");
  const source = parseEnvironment(await readPrivateRegularFile(sourcePath));
  const adminBaseUrl = normalizeAdminBaseUrl(source.SUB2API_ADMIN_BASE_URL ?? source.SUB2API_BASE_URL ?? "");
  const adminToken = required(source.SUB2API_ADMIN_TOKEN, "legacy SUB2API_ADMIN_TOKEN");
  const pollSeconds = normalizePollSeconds(options.pollSeconds ?? "5");
  const importConcurrency = normalizeImportConcurrency(source.SUB2API_IMPORT_CONCURRENCY ?? "2");
  const values = {
    SUB2API_ADMIN_BASE_URL: adminBaseUrl,
    SUB2API_ADMIN_TOKEN: adminToken,
    ...(optional(source.SUB2API_ADMIN_REFRESH_TOKEN) ? { SUB2API_ADMIN_REFRESH_TOKEN: optional(source.SUB2API_ADMIN_REFRESH_TOKEN) } : {}),
    SUB2API_IMPORT_PROXY_NAME: optional(source.SUB2API_IMPORT_PROXY_NAME) ?? "default",
    SUB2API_IMPORT_GROUP_NAME: optional(source.SUB2API_IMPORT_GROUP_NAME) ?? "test",
    SUB2API_IMPORT_CONCURRENCY: String(importConcurrency),
    SUB2API_IMPORT_POLL_SECONDS: String(pollSeconds),
    ...(options.queueDirectory ? { SUB2API_IMPORT_QUEUE_DIR: requireAbsolutePath(options.queueDirectory, "--queue-dir") } : {}),
    ...(options.stateDirectory ? { SESSION_INGRESS_STATE_DIR: requireAbsolutePath(options.stateDirectory, "--state-dir") } : {})
  };
  await writeNewPrivateEnvironment(destinationPath, values);
  return { destinationPath, pollSeconds };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      process.stdout.write("Usage: migrate-legacy-env --source <private-env> --destination <new-private-env> [--queue-dir <absolute-dir>] [--state-dir <absolute-dir>] [--poll-seconds <1-3600>]\n");
      process.exit(0);
    }
    const key = {
      "--source": "sourcePath",
      "--destination": "destinationPath",
      "--queue-dir": "queueDirectory",
      "--state-dir": "stateDirectory",
      "--poll-seconds": "pollSeconds"
    }[argument];
    if (!key || index + 1 >= args.length) {
      throw new Error("Invalid migration arguments.");
    }
    options[key] = args[index + 1];
    index += 1;
  }
  if (!options.sourcePath || !options.destinationPath) {
    throw new Error("--source and --destination are required.");
  }
  return options;
}

async function readPrivateRegularFile(target) {
  const info = await fs.lstat(target);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isFile() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new Error("Legacy environment file is unsafe.");
  }
  return fs.readFile(target, "utf8");
}

function parseEnvironment(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

async function writeNewPrivateEnvironment(target, values) {
  await ensurePrivateDirectory(path.dirname(target));
  try {
    await fs.lstat(target);
    throw new Error("Destination private environment file already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${serializeEnvironmentValue(value)}`)
    .join("\n") + "\n";
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(target);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new Error("Destination private directory is unsafe.");
  }
  await fs.chmod(target, 0o700);
}

function serializeEnvironmentValue(value) {
  return String(value).replace(/\r|\n/gu, "");
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(value.trim());
}

function normalizePollSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("--poll-seconds must be an integer from 1 to 3600.");
  }
  return seconds;
}

function normalizeImportConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error("legacy SUB2API_IMPORT_CONCURRENCY must be an integer from 1 to 100.");
  }
  return concurrency;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write("Could not migrate the private Sub2API importer configuration.\n");
    process.exitCode = 1;
  });
}

module.exports = { migrateLegacyEnvironment, parseEnvironment, parseArguments };
