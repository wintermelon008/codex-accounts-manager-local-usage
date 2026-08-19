import { parseAssistantCommand } from "./command.mjs";

export const PRIVATE_CHAT_ONLY_MESSAGE = "操纵助手仅支持与机器人的一对一私聊；不会在群聊中执行 Manager 操作。";
export const UNAUTHORIZED_MESSAGE = "操纵助手\n拒绝操作：当前发送者不在管理员白名单中。";
export const PAYMENT_NOT_CONFIGURED_MESSAGE = "支付流程尚未配置具体第三方网站适配器。";
export const WEB_WORKFLOW_NOT_CONFIGURED_MESSAGE = "网页分析流程尚未配置。";

export async function handleAssistantEvent(event, options) {
  const message = event?.message;
  const text = extractTextContent(message?.content);
  if (!text) {
    return { handled: false };
  }
  if (message?.chat_type !== "p2p") {
    return { handled: true, reply: PRIVATE_CHAT_ONLY_MESSAGE };
  }
  const senderOpenId = senderOpenIdFrom(event?.sender);
  if (!senderOpenId || !options.adminOpenIds.has(senderOpenId)) {
    return { handled: true, reply: UNAUTHORIZED_MESSAGE };
  }

  const command = parseAssistantCommand(text);
  if (!command || command.action === "help" || command.action === "unknown") {
    return {
      handled: true,
      reply: assistantHelp(Boolean(options.paymentWorkflow), Boolean(options.webWorkflow))
    };
  }
  if (command.action === "invalid") {
    return {
      handled: true,
      reply: `操纵助手\n${command.message}\n\n${assistantHelp(Boolean(options.paymentWorkflow), Boolean(options.webWorkflow))}`
    };
  }

  try {
    if (command.action === "health") {
      const health = await options.manager.getHealth();
      return { handled: true, reply: formatHealth(health) };
    }
    if (command.action === "status") {
      const status = await options.manager.getStatus();
      return { handled: true, reply: formatStatus(status) };
    }
    if (command.action === "usage") {
      const usage = await options.manager.getUsageToday();
      return { handled: true, reply: formatUsage(usage) };
    }
    if (command.action === "refresh") {
      const job = await options.manager.refreshQuotas(command.accountIds);
      return {
        handled: true,
        reply: `额度刷新已启动\n任务编号：${job.id}\n${command.accountIds?.length ? `目标账号：${command.accountIds.join(", ")}\n` : "目标：全部可刷新账号\n"}稍后将回报结果。`,
        followUpJobId: job.id
      };
    }
    if (command.action === "buy") {
      if (!options.paymentWorkflow) {
        return { handled: true, reply: `操纵助手\n${PAYMENT_NOT_CONFIGURED_MESSAGE}` };
      }
      const order = await options.paymentWorkflow.begin({
        requesterId: senderOpenId,
        chatId: message.chat_id,
        productId: command.productId,
        quantity: command.quantity
      });
      return {
        handled: true,
        reply: formatPaymentStart(order.order, order.created),
        paymentOrder: order.order,
        paymentQr: order.order.qr
      };
    }
    if (command.action === "payment-status") {
      if (!options.paymentWorkflow) {
        return { handled: true, reply: `操纵助手\n${PAYMENT_NOT_CONFIGURED_MESSAGE}` };
      }
      const order = await options.paymentWorkflow.syncForRequester(senderOpenId, command.orderId);
      return order
        ? { handled: true, reply: formatPaymentStatus(order), paymentOrder: order }
        : { handled: true, reply: "支付状态\n当前没有属于你的进行中订单。" };
    }
    if (command.action === "analyze-web") {
      if (!options.webWorkflow) {
        return { handled: true, reply: `操纵助手\n${WEB_WORKFLOW_NOT_CONFIGURED_MESSAGE}` };
      }
      const plan = await options.webWorkflow.analyze({
        url: command.url,
        criteria: command.criteriaText,
        remember: true
      });
      return { handled: true, reply: formatWebWorkflowPlan(plan), webWorkflowPlan: plan };
    }
    if (command.action === "web-workflow") {
      if (!options.webWorkflow) {
        return { handled: true, reply: `操纵助手\n${WEB_WORKFLOW_NOT_CONFIGURED_MESSAGE}` };
      }
      const workflow = await options.webWorkflow.getSaved(command.url);
      return {
        handled: true,
        reply: workflow ? formatWebWorkflowPlan(workflow) : "网页流程\n未找到已保存记录，请先发送“分析商品 <URL>”。",
        webWorkflowPlan: workflow
      };
    }
    if (command.action === "import-status") {
      const status = await options.manager.getImportStatus(command.jobId);
      return { handled: true, reply: formatImportStatus(status) };
    }
  } catch (error) {
    return { handled: true, reply: `操纵助手\n${safeErrorMessage(error)}` };
  }
  return {
    handled: true,
    reply: assistantHelp(Boolean(options.paymentWorkflow), Boolean(options.webWorkflow))
  };
}

export function extractTextContent(content) {
  if (typeof content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.text === "string" ? parsed.text.replace(/<at[^>]*>.*?<\/at>/giu, " ").trim() : "";
  } catch {
    return "";
  }
}

export function senderOpenIdFrom(sender) {
  const openId = sender?.sender_id?.open_id;
  return typeof openId === "string" && openId.trim() ? openId.trim() : undefined;
}

export function formatHealth(health) {
  if (health?.ok === true) {
    return `Manager 控制接口正常\n服务：${health.service ?? "codex-accounts-manager"}`;
  }
  return "Manager 控制接口返回了异常状态。";
}

export function formatStatus(status) {
  const counts = status?.accounts?.counts ?? {};
  const accounts = Array.isArray(status?.accounts?.accounts) ? status.accounts.accounts : [];
  const lines = [
    "Manager 账号状态",
    `账号：${numberOrZero(counts.total)}（可见 ${numberOrZero(counts.visible)}，隐藏 ${numberOrZero(counts.hidden)}，活跃 ${numberOrZero(counts.active)}）`,
    `健康：${numberOrZero(counts.healthy)} 正常，${numberOrZero(counts.authFailed)} 鉴权失败，${numberOrZero(counts.quotaLimited)} 额度受限`,
    `无感池：${numberOrZero(counts.poolEnabled)} 已启用，${numberOrZero(counts.poolEligible)} 符合资格`,
    "",
    formatUsage(status?.usageToday)
  ];
  if (accounts.length > 0) {
    lines.push("", "账号明细：");
    for (const account of accounts.slice(0, 30)) {
      lines.push(formatAccount(account));
    }
    if (accounts.length > 30) {
      lines.push(`……还有 ${accounts.length - 30} 个账号未展开。`);
    }
  }
  return lines.join("\n");
}

export function formatUsage(usage) {
  if (!usage) {
    return "今日 Token 用量\n暂无数据。";
  }
  const total = usage.total ?? {};
  const lines = [
    "今日 Token 用量",
    `日期：${usage.date || "未知"}（${usage.timeZone || "本地时区"}）`,
    `总量：${formatInteger(total.totalTokens)} tokens`,
    `输入：${formatInteger(total.inputTokens)}，缓存输入：${formatInteger(total.cachedInputTokens)}，输出：${formatInteger(total.outputTokens)}，推理输出：${formatInteger(total.reasoningOutputTokens)}`,
    `事件：${formatInteger(usage.eventCount)}，状态：${usage.status ?? "unknown"}`
  ];
  const byModel = Array.isArray(usage.byModel) ? usage.byModel : [];
  if (byModel.length > 0) {
    lines.push("按模型：");
    for (const model of byModel.slice(0, 10)) {
      lines.push(`- ${model.model || "未知模型"}：${formatInteger(model.totalTokens)} tokens`);
    }
  }
  return lines.join("\n");
}

export function formatImportStatus(status) {
  const state = status?.state ?? "unknown";
  const label =
    {
      queued: "排队中",
      processing: "处理中",
      completed: "已完成",
      partial: "部分完成",
      failed: "失败",
      unknown: "未找到"
    }[state] ?? state;
  const lines = [`导入任务 ${status?.id ?? "未知"}`, `状态：${label}`];
  if (status && ["completed", "partial", "failed"].includes(state)) {
    lines.push(
      `共 ${numberOrZero(status.total)} 个，已导入 ${numberOrZero(status.imported)} 个，` +
        `无感池 ${numberOrZero(status.poolEnabled)} 个，额度刷新失败 ${numberOrZero(status.refreshFailed)} 个，` +
        `资格未通过 ${numberOrZero(status.notEligible)} 个。`
    );
    if (status.authFailed !== undefined || status.importFailed !== undefined) {
      lines.push(`鉴权失败 ${numberOrZero(status.authFailed)} 个，导入失败 ${numberOrZero(status.importFailed)} 个。`);
    }
  }
  return lines.join("\n");
}

export function formatJob(job) {
  const state = job?.state ?? "unknown";
  if (state === "completed") {
    const result = job.result ?? {};
    return (
      `额度刷新完成\n任务编号：${job.id}\n` +
      `成功 ${numberOrZero(result.succeeded)}，失败 ${numberOrZero(result.failed)}，` +
      `未知账号 ${numberOrZero(result.unknownAccountIds?.length)}`
    );
  }
  if (state === "failed") {
    return `额度刷新失败\n任务编号：${job.id}`;
  }
  return `额度刷新任务状态：${state}\n任务编号：${job?.id ?? "未知"}`;
}

export function formatPaymentStart(order, created = true) {
  const prefix = created ? "支付订单已创建" : "已有进行中的支付订单";
  return (
    `${prefix}\n订单号：${order?.orderId ?? "创建中"}\n商品：${order?.productId ?? "未知"}\n金额：${formatMoney(order?.amountFen, order?.currency)}\n` +
    "请使用随后发送的二维码完成支付；只有确认支付成功后才会执行账号获取与 Manager 导入。\n" +
    "可发送“支付状态”查询进度。"
  );
}

export function formatPaymentStatus(order) {
  const labels = {
    creating: "正在创建订单",
    awaiting_payment: "等待支付",
    fulfilling: "已确认支付，正在执行后续流程",
    fulfillment_pending: "支付已确认，Manager 导入仍在处理",
    fulfillment_failed: "支付已确认，但后续流程失败，将保留订单等待重试",
    fulfilled: "支付和后续导入已完成",
    payment_failed: "支付失败",
    payment_expired: "支付已过期"
  };
  const lines = ["支付状态", `订单号：${order?.orderId ?? "创建中"}`, `状态：${labels[order?.state] ?? "未知"}`];
  if (order?.managerImportJobId) {
    lines.push(`Manager 导入任务：${order.managerImportJobId}`);
  }
  if (order?.lastError) {
    lines.push(`说明：${order.lastError}`);
  }
  return lines.join("\n");
}

export function assistantHelp(paymentConfigured = false, webWorkflowConfigured = false) {
  const paymentHelp = paymentConfigured
    ? "购买 <商品编号>：创建支付订单并发送二维码；支付确认后才会执行后续导入。\n支付状态：查询当前支付订单。\n"
    : "支付/购买流程暂未配置具体第三方支付平台适配器。\n";
  const webHelp = webWorkflowConfigured
    ? "分析商品 <HTTPS URL> [条件]：分析商品、筛选最低价并保存网页步骤。\n网页流程 <HTTPS URL>：查看已保存流程。\n"
    : "网页分析流程暂未配置。\n";
  return (
    "Manager 操纵助手\n" +
    "账号 / 状态：查看账号、健康、额度池和今日用量。\n" +
    "用量：查看今日 Token 使用。\n" +
    "刷新额度 [账号 ID ...]：刷新全部或指定账号额度。\n" +
    "导入状态 <任务编号>：查询本地导入任务。\n" +
    "健康：检查 Manager 控制接口。\n" +
    paymentHelp +
    webHelp
  );
}

export function formatWebWorkflowPlan(plan) {
  const lines = [
    "网页商品分析",
    `页面：${displayText(plan?.title) || "未命名页面"}`,
    `地址：${displayText(plan?.url) || "未知"}`,
    `状态：${formatSiteStatus(plan?.siteStatus)}`,
    `筛选：${formatCriteria(plan?.criteria)}`
  ];
  if (plan?.unavailableReason) {
    lines.push(`原因：${displayText(plan.unavailableReason)}`);
  }
  if (plan?.requiresBrowser) {
    lines.push("提示：页面可能需要浏览器渲染，当前结果基于初始 HTML。");
  }
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  if (plan?.selected) {
    lines.push(`最低价候选：${formatProduct(plan.selected)}`);
  } else {
    lines.push("最低价候选：未找到符合条件且有明确价格的商品。");
  }
  if (candidates.length > 0) {
    lines.push("候选排序：");
    for (const product of candidates.slice(0, 10)) {
      lines.push(`- ${formatProduct(product)}`);
    }
    if (candidates.length > 10) {
      lines.push(`……还有 ${candidates.length - 10} 个候选。`);
    }
  }
  const instructions = Array.isArray(plan?.instructions) ? plan.instructions : [];
  if (instructions.length > 0) {
    lines.push("使用指引：");
    for (const step of instructions.slice(0, 20)) {
      lines.push(formatInstruction(step));
    }
    if (instructions.length > 20) {
      lines.push(`……还有 ${instructions.length - 20} 个步骤。`);
    }
  }
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.filter(Boolean) : [];
  if (warnings.length > 0) {
    lines.push("注意：");
    for (const warning of warnings.slice(0, 10)) {
      lines.push(`- ${displayText(warning)}`);
    }
  }
  if (plan?.remembered === true || plan?.savedAt) {
    lines.push("已保存该网页流程，后续可发送“网页流程 <URL>”查询。");
  }
  return lines.join("\n");
}

function formatMoney(amountFen, currency = "CNY") {
  return Number.isInteger(amountFen) && amountFen >= 0
    ? `${displayText(currency) || "CNY"} ${(amountFen / 100).toFixed(2)}`
    : "待确认";
}

function formatSiteStatus(status) {
  return { available: "可访问", unavailable: "不可用", unknown: "未知" }[status] ?? "未知";
}

function formatCriteria(criteria = {}) {
  const values = [];
  if (criteria.plan) values.push(`方案=${displayText(criteria.plan)}`);
  if (criteria.phoneVerified === true) values.push("已接码/手机已验证");
  if (criteria.phoneVerified === false) values.push("未要求接码");
  if (criteria.inStock === true) values.push("有库存");
  if (Number.isInteger(criteria.maxPriceFen)) values.push(`最高价=${formatMoney(criteria.maxPriceFen, "CNY")}`);
  values.push("价格升序");
  return values.join("，");
}

function formatProduct(product = {}) {
  const features = Array.isArray(product.features) ? product.features.slice(0, 3).map(displayText).filter(Boolean) : [];
  const flags = [
    product.phoneVerified === true ? "已接码" : product.phoneVerified === false ? "未接码" : "接码未知",
    product.inStock === true
      ? `有库存${product.stockCount === null || product.stockCount === undefined ? "" : `(${product.stockCount})`}`
      : "无库存/未知"
  ];
  return `${displayText(product.name) || "未命名商品"}（${formatMoney(product.priceFen, product.currency)}；${flags.join("，")}${
    features.length > 0 ? `；${features.join("、")}` : ""
  }；ID=${displayText(product.id) || "未知"}）`;
}

function formatInstruction(step = {}) {
  const action =
    { open: "打开", click: "点击", fill: "填写", wait: "等待", copy: "复制", submit: "提交", note: "备注" }[
      step.action
    ] ??
    (displayText(step.action) || "步骤");
  const value = step.sensitive || step.value === null || step.value === undefined ? "" : `：${displayText(step.value)}`;
  const confirmation = step.requiresConfirmation ? "（需确认）" : "";
  return `${Number.isInteger(step.order) ? `${step.order}. ` : "- "}${action} ${displayText(step.target) || "未说明目标"}${value}${confirmation}`;
}

function displayText(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500)
    : "";
}

function formatAccount(account) {
  const health =
    { healthy: "正常", auth: "鉴权失败", quota: "额度受限", disabled: "已停用" }[account?.health] ?? "未知";
  const pool = account?.balancePoolEnabled ? (account.poolEligible ? "无感池✓" : "无感池待定") : "无感池-";
  const hourly = formatWindow(account?.quota?.hourly, "小时");
  const weekly = formatWindow(account?.quota?.weekly, "周");
  return `- ${account?.displayName || account?.email || account?.id || "未知账号"} [${account?.id || "无 ID"}]：${health}，${pool}${hourly || weekly ? `，${hourly}${hourly && weekly ? "，" : ""}${weekly}` : ""}`;
}

function formatWindow(window, label) {
  if (!window) {
    return "";
  }
  if (typeof window.percentage === "number") {
    return `${label}余量 ${Math.round(window.percentage)}%`;
  }
  if (typeof window.requestsLeft === "number") {
    return `${label}余量 ${window.requestsLeft}${typeof window.requestsLimit === "number" ? `/${window.requestsLimit}` : ""}`;
  }
  return "";
}

function formatInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString("en-US") : "0";
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function safeErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message.length <= 240) {
    return error.message;
  }
  return "操作失败，请检查 Manager 是否已启动及控制令牌是否一致。";
}
