"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.main !== "./src/extension.cjs") {
  throw new Error("Mailbox package main must remain the optional extension entry");
}
if (!packageJson.activationEvents?.includes("onStartupFinished")) {
  throw new Error("Mailbox package must activate only as an optional startup integration");
}
const runtimeDependencies = Object.keys(packageJson.dependencies || {});
const unsupportedDependencies = runtimeDependencies.filter((name) => name !== "playwright");
if (unsupportedDependencies.length > 0) {
  throw new Error(`Mailbox package has unsupported runtime dependencies: ${unsupportedDependencies.join(", ")}`);
}
for (const file of ["README.md", ".vscodeignore", "src/extension.cjs"]) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Mailbox package is missing ${file}`);
  }
}
process.stdout.write("Mailbox package shape passed\n");
