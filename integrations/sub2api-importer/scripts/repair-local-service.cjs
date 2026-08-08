#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { loadConfiguration } = require("../src/config.cjs");
const { createSub2ApiAdminClient, Sub2ApiImportError } = require("../src/sub2apiClient.cjs");

const SUB2API_SERVICE = "sub2api.service";
const IMPORTER_SERVICE = "codex-accounts-sub2api-importer.service";
const ADMIN_PROBE_PATH = "/api/v1/admin/groups/all";

async function main() {
  run("sudo", ["systemctl", "enable", SUB2API_SERVICE]);
  run("sudo", ["systemctl", "restart", SUB2API_SERVICE]);

  loadPrivateEnvironment();
  const configuration = loadConfiguration();
  await waitForAdministratorApi(configuration);

  run("systemctl", ["--user", "restart", IMPORTER_SERVICE]);
  process.stdout.write("Sub2API repair completed.\n");
}

function loadPrivateEnvironment() {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const content = fs.readFileSync(path.join(configRoot, "codex-accounts-sub2api-importer", "env"), "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

async function waitForAdministratorApi(configuration) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const client = await createSub2ApiAdminClient(configuration);
      await client.getJson(ADMIN_PROBE_PATH);
      return;
    } catch (error) {
      if (!(error instanceof Sub2ApiImportError) || error.kind !== "transportFailure" || attempt === 29) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.message.includes("SUB2API_ADMIN_API_KEY")) {
    process.stderr.write("Create an Admin API Key in Sub2API Settings, then add it to ~/.config/codex-accounts-sub2api-importer/env.\n");
  }
  process.exitCode = 1;
});
