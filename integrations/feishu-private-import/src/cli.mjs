#!/usr/bin/env node

import { createFeishuClient } from "./feishuClient.mjs";
import { loadConfiguration, resolveQueueOptions } from "./config.mjs";
import { createFeishuEventServer } from "./server.mjs";

async function main() {
  const configuration = loadConfiguration();
  const client = createFeishuClient({ appId: configuration.appId, appSecret: configuration.appSecret });
  const server = createFeishuEventServer({
    ...configuration,
    queueOptions: resolveQueueOptions(configuration),
    client
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.info("Feishu private-import bot is ready.");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

void main().catch(() => {
  console.error("Feishu private-import bot could not start. Check its private configuration.");
  process.exitCode = 1;
});
