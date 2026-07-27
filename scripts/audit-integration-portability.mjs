#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const changedFiles = new Set([
  ...gitLines(["diff", "--name-only", "--diff-filter=ACMR"]),
  ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"])
]);
const inspected = [...changedFiles]
  .filter((file) => isDeliverable(file))
  .filter((file) => isTextFile(file))
  .sort();
const violations = [];

for (const file of inspected) {
  const content = readFileSync(path.join(root, file), "utf8");
  const kinds = findSensitiveOrMachineSpecificContent(content);
  if (kinds.length > 0) {
    violations.push(`${file} (${kinds.join(", ")})`);
  }
}

if (violations.length > 0) {
  throw new Error(`integration portability audit failed: ${violations.join("; ")}`);
}

console.log(`integration portability audit passed (${inspected.length} deliverable files checked)`);

function isDeliverable(file) {
  return (
    file === "README.md" ||
    file === "README.en.md" ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "local-customization.json" ||
    file === ".vscodeignore" ||
    file.startsWith("docs/") ||
    file.startsWith("integrations/") ||
    file.startsWith("src/integrations/") ||
    file === "src/codex/hotSwitchBridge.ts" ||
    file === "src/codex/hotSwitchRuntime.ts" ||
    file === "src/application/accounts/gatewayFallbackSelection.ts" ||
    file === "src/application/accounts/runtimeSwitchCoordinator.ts" ||
    file === "src/domain/dashboard/types.ts" ||
    file === "src/infrastructure/config/extensionSettings.ts" ||
    file === "src/extension.ts" ||
    file === "src/presentation/dashboard/actionHandlers.ts" ||
    file === "src/presentation/dashboard/signature.ts" ||
    file === "src/presentation/workbench/accountsWorkbench.ts" ||
    file === "src/presentation/workbench/localImportInbox.ts" ||
    file === "src/presentation/workbench/refreshCoordinator.ts" ||
    file === "runtime/codex-app-server-shim.cjs" ||
    file === "webview-src/dashboard/host.ts" ||
    file === "webview-src/dashboard/main.tsx" ||
    file === "webview-src/dashboard/integrationCards.tsx" ||
    file.startsWith("test/") ||
    file === "scripts/audit-integration-portability.mjs"
  );
}

function isTextFile(file) {
  try {
    const info = statSync(path.join(root, file));
    return info.isFile() && info.size <= 2 * 1024 * 1024;
  } catch {
    return false;
  }
}

function findSensitiveOrMachineSpecificContent(content) {
  const findings = [];
  if (/\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u.test(content)) findings.push("POSIX home path");
  if (/\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u.test(content)) findings.push("macOS home path");
  if (/\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/u.test(content)) findings.push("Windows home path");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) findings.push("private key");
  if (/(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}/u.test(content)) findings.push("API-like key");
  if (
    /\b[A-Za-z0-9._%+-]+@(?!example\.(?:invalid|com|net|org)\b)[A-Za-z0-9.-]+\.(?:com|net|org|cn|io|dev|ai)\b/u.test(
      content
    )
  ) {
    findings.push("email-like identifier");
  }
  return findings;
}

function gitLines(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
