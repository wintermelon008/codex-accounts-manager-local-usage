#!/usr/bin/env node
"use strict";

const { loadConfiguration } = require("./config.cjs");
const { processOutbox } = require("./worker.cjs");

async function main() {
  const configuration = loadConfiguration();
  const once = process.argv.includes("--once");
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await processOutbox(configuration);
      if (summary.completed || summary.failed) {
        process.stdout.write(`Sub2API importer processed ${summary.completed} completed and ${summary.failed} failed job(s).\n`);
      }
    } catch {
      process.stderr.write("Sub2API importer could not safely process the private queue.\n");
    } finally {
      running = false;
    }
  };
  await run();
  if (once) return;
  const timer = setInterval(() => void run(), configuration.pollSeconds * 1000);
  const stop = () => {
    clearInterval(timer);
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch(() => {
  process.stderr.write("Sub2API importer configuration is invalid.\n");
  process.exitCode = 1;
});
