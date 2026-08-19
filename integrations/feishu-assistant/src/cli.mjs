#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { createFeishuAssistant } from "./feishuBot.mjs";
import { createManagerClient } from "./managerClient.mjs";
import { loadPaymentProvider } from "./paymentProviderLoader.mjs";
import { createPaymentStore } from "./paymentStore.mjs";
import { createPaymentWorkflow } from "./paymentWorkflow.mjs";
import { createDeterministicPageAnalyzer, createOpenAIPageAnalyzer } from "./webAnalyzer.mjs";
import { loadWebWorkflowExecutor } from "./webWorkflowExecutorLoader.mjs";
import { createWebWorkflowStore } from "./webWorkflowStore.mjs";
import { createWebWorkflowService } from "./webWorkflowService.mjs";

const config = loadConfig();
const manager = createManagerClient(config.manager);
const webAnalyzer = config.web.openAiApiKey
  ? createOpenAIPageAnalyzer({
      apiKey: config.web.openAiApiKey,
      baseUrl: config.web.openAiBaseUrl,
      model: config.web.model
    })
  : createDeterministicPageAnalyzer();
const webExecutor = await loadWebWorkflowExecutor(config.web.executorModule, { env: process.env });
const webWorkflow = createWebWorkflowService({
  store: createWebWorkflowStore({ statePath: config.web.workflowStatePath, env: process.env }),
  analyzer: webAnalyzer,
  executor: webExecutor
});
const paymentProvider = await loadPaymentProvider(config.payment.providerModule, {
  manager,
  env: process.env,
  webWorkflow
});
const paymentWorkflow = paymentProvider
  ? createPaymentWorkflow({
      provider: paymentProvider,
      store: createPaymentStore({ statePath: config.payment.statePath, env: process.env }),
      pollIntervalMs: config.payment.pollIntervalMs
    })
  : undefined;
const bot = createFeishuAssistant({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  adminOpenIds: config.feishu.adminOpenIds,
  manager,
  paymentWorkflow,
  webWorkflow
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void bot.stop().finally(() => process.exit(0));
  });
}

await bot.start();
console.log("[feishu-assistant] started with Feishu long connection");
