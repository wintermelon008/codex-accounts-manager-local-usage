import { fetchWebPageSnapshot, normalizeWebUrl } from "./webPage.mjs";
import {
  buildWorkflowPlan,
  normalizeCriteria,
  normalizePageAnalysis,
  publicWorkflowRecord,
  WEB_WORKFLOW_SCHEMA
} from "./webWorkflowSchema.mjs";

const EXECUTION_STATES = new Set(["pending", "completed", "failed"]);
const MAX_MESSAGE_LENGTH = 240;

export class WebWorkflowError extends Error {
  constructor(message, code = "web_workflow_error") {
    super(message);
    this.name = "WebWorkflowError";
    this.code = code;
  }
}

export function createWebWorkflowService(options = {}) {
  const store = options.store;
  if (!store || typeof store.get !== "function" || typeof store.put !== "function") {
    throw new WebWorkflowError("网页流程存储未配置。", "web_workflow_store");
  }
  const fetchPage = options.fetchPage ?? fetchWebPageSnapshot;
  const analyzer = options.analyzer;
  if (!analyzer || typeof analyzer.analyze !== "function") {
    throw new WebWorkflowError("网页分析器未配置。", "web_workflow_analyzer");
  }
  const executor = options.executor;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async analyze(input = {}) {
      const url = normalizeWebUrl(input.url);
      const criteria = normalizeCriteria(input.criteria ?? input.criteriaText);
      const previous = await store.get(url);
      const snapshot = await fetchPage(url);
      const rawAnalysis = await analyzer.analyze(snapshot, { criteria, previous });
      const analysis = normalizePageAnalysis(rawAnalysis, snapshot);
      const plan = buildWorkflowPlan(snapshot, analysis, criteria, previous);
      if (input.remember === false) {
        return { ...plan, remembered: false };
      }

      const record = toStoredWorkflow(plan, analysis, now());
      await store.put(record);
      const saved = await store.get(url);
      return {
        ...plan,
        savedAt: saved?.updatedAt ?? record.updatedAt,
        remembered: true
      };
    },

    async getSaved(url) {
      const record = await store.get(normalizeWebUrl(url));
      return record ? publicWorkflowRecord(record) : undefined;
    },

    async listSaved() {
      if (typeof store.list !== "function") {
        return [];
      }
      return (await store.list()).map((record) => publicWorkflowRecord(record));
    },

    async removeSaved(url) {
      if (typeof store.remove !== "function") {
        throw new WebWorkflowError("网页流程存储不支持删除。", "web_workflow_store");
      }
      await store.remove(normalizeWebUrl(url));
    },

    async executeAfterPayment(input = {}) {
      if (input.payment?.state !== "paid") {
        throw new WebWorkflowError("网页流程只能在支付状态明确为 paid 后执行。", "web_workflow_payment_required");
      }
      if (!executor || typeof executor.execute !== "function") {
        throw new WebWorkflowError("尚未配置该网站的显式网页执行器。", "web_workflow_executor_missing");
      }
      const url = normalizeWebUrl(input.url ?? input.workflowUrl ?? input.workflow?.url);
      const record = await store.get(url);
      if (!record) {
        throw new WebWorkflowError("未找到该网页的已保存流程，请先分析网页。", "web_workflow_not_found");
      }
      const workflow = publicWorkflowRecord(record);
      if (!workflow.selected) {
        throw new WebWorkflowError("该网页流程没有可履约的已选商品。", "web_workflow_product_missing");
      }

      let result;
      try {
        result = await executor.execute({
          workflow,
          selected: workflow.selected,
          order: normalizeOrder(input.order),
          payment: normalizePayment(input.payment),
          previousResult: normalizeExecutionResult(input.previousResult, { allowMissing: true })
        });
      } catch (error) {
        if (error instanceof WebWorkflowError) {
          throw error;
        }
        throw new WebWorkflowError("网页支付后流程执行失败。", "web_workflow_execution");
      }
      return normalizeExecutionResult(result);
    }
  };
}

function toStoredWorkflow(plan, analysis, updatedAt) {
  return {
    schema: WEB_WORKFLOW_SCHEMA,
    url: plan.url,
    title: plan.title,
    siteStatus: plan.siteStatus,
    unavailableReason: plan.unavailableReason,
    requiresBrowser: plan.requiresBrowser,
    criteria: plan.criteria,
    analysis,
    updatedAt
  };
}

export function normalizeExecutionResult(value, options = {}) {
  if (!value && options.allowMissing) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebWorkflowError("网页执行器没有返回有效结果。", "web_workflow_result");
  }
  const rawState = stringValue(value.state ?? value.status)?.toLocaleLowerCase();
  const state =
    rawState === "processing"
      ? "pending"
      : ["success", "succeeded", "complete"].includes(rawState)
        ? "completed"
        : rawState;
  if (!EXECUTION_STATES.has(state)) {
    throw new WebWorkflowError("网页执行器没有返回明确状态。", "web_workflow_result");
  }
  return {
    state,
    managerImportJobId: stringValue(value.managerImportJobId ?? value.manager_import_job_id ?? value.importJobId),
    imported: nonNegativeInteger(value.imported),
    poolEnabled: nonNegativeInteger(value.poolEnabled ?? value.pool_enabled),
    message: safeMessage(value.message)
  };
}

function normalizeOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return {
    orderId: stringValue(value.orderId),
    productId: stringValue(value.productId),
    quantity: nonNegativeInteger(value.quantity),
    amountFen: nonNegativeInteger(value.amountFen),
    currency: stringValue(value.currency)?.toLocaleUpperCase(),
    paidAt: stringValue(value.paidAt)
  };
}

function normalizePayment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: "paid" };
  }
  return {
    state: "paid",
    paidAt: stringValue(value.paidAt),
    reference: stringValue(value.reference ?? value.paymentReference)
  };
}

function stringValue(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function safeMessage(value) {
  const message = stringValue(value);
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return undefined;
  }
  return message.replace(
    /((?:bearer\s+|access[_ -]?token[=: ]+|refresh[_ -]?token[=: ]+|password[=: ]+|secret[=: ]+|api[_ -]?key[=: ]+))[^\s,;]+/giu,
    "$1[redacted]"
  );
}
