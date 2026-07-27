"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const dist = path.join(__dirname, "..", "dist");

async function main() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true, mode: 0o700 });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
