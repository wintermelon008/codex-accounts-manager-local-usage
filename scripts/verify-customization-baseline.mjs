#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const customizationPath = path.join(root, "local-customization.json");
const customization = JSON.parse(readFileSync(customizationPath, "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const baseline = customization?.upstream?.commit;
const protectedFiles = new Set(customization?.protectedFiles ?? []);
const removedFiles = new Set(customization?.removedFiles ?? []);
const expectedHashes = customization?.expectedFileSha256 ?? {};

if (customization?.schemaVersion !== 1 || customization?.feature !== "local-enhancements") {
  fail("local-customization.json is not a recognized local enhancement manifest");
}
if (!baseline || typeof baseline !== "string") {
  fail("local-customization.json has no upstream commit baseline");
}
if (customization?.localBuildVersion !== packageJson.version) {
  fail("local build version does not match package.json");
}
for (const file of removedFiles) {
  if (protectedFiles.has(file)) {
    fail(`a file cannot be both protected and removed: ${file}`);
  }
}

runGit(["rev-parse", "--verify", `${baseline}^{commit}`]);

const changedFiles = new Set([
  ...gitLines(["diff", "--name-only", `${baseline}...HEAD`]),
  ...gitLines(["diff", "--name-only"]),
  ...gitLines(["diff", "--cached", "--name-only"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"])
]);
changedFiles.delete("local-customization.json");

const unexpected = [...changedFiles].filter((file) => !protectedFiles.has(file) && !removedFiles.has(file)).sort();
if (unexpected.length > 0) {
  fail(`upstream or unreviewed files changed: ${unexpected.join(", ")}`);
}

for (const file of removedFiles) {
  if (existsSync(path.join(root, file))) {
    fail(`reviewed removed file is present: ${file}`);
  }
}

for (const file of protectedFiles) {
  const expected = expectedHashes[file];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) {
    fail(`missing reviewed SHA-256 for ${file}`);
  }
  const actual = sha256(path.join(root, file));
  if (actual !== expected) {
    fail(`reviewed file changed: ${file}`);
  }
}

console.log(
  `Customization baseline verified for upstream ${customization.upstream.version} (${baseline.slice(0, 12)})`
);

function gitLines(args) {
  return runGit(args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function runGit(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message) {
  console.error(`Customization baseline check failed: ${message}`);
  console.error("Run a Codex review of the target upstream version before updating local-customization.json.");
  process.exitCode = 1;
  throw new Error(message);
}
