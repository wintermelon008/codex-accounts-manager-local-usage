const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseAssistantCommand(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  let normalized = text.trim();
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1).trimStart();
  }
  if (!normalized) {
    return undefined;
  }
  const [keyword, ...rest] = normalized.split(/\s+/u);
  const argument = rest.join(" ").trim();
  const lower = keyword.toLocaleLowerCase();

  if (["帮助", "菜单", "help", "h"].includes(lower)) {
    return { action: "help" };
  }
  if (["账号", "状态", "账号状态", "status"].includes(lower)) {
    return { action: "status" };
  }
  if (["用量", "今日用量", "token", "tokens", "usage"].includes(lower)) {
    return { action: "usage" };
  }
  if (["健康", "health", "ping"].includes(lower)) {
    return { action: "health" };
  }
  if (["刷新额度", "额度刷新", "refresh", "quota"].includes(lower)) {
    const accountIds = parseAccountIds(argument);
    return accountIds === "invalid"
      ? { action: "invalid", message: "刷新额度后只能跟账号 ID，并以空格分隔。" }
      : { action: "refresh", accountIds };
  }
  if (["购买", "支付", "buy", "pay"].includes(lower)) {
    return argument ? { action: "buy", productId: argument } : { action: "invalid", message: "购买后需要商品编号。" };
  }
  if (["支付状态", "订单状态", "payment-status", "payment"].includes(lower)) {
    return { action: "payment-status", orderId: argument || undefined };
  }
  if (["分析商品", "商品分析", "分析网页", "网页分析", "analyze-product", "analyze-web"].includes(lower)) {
    const parsed = parseWebUrlAndCriteria(argument);
    return parsed ?? { action: "invalid", message: "分析商品后需要 HTTPS 网页地址，可在地址后附加筛选条件。" };
  }
  if (["网页流程", "查看网页流程", "web-workflow", "workflow"].includes(lower)) {
    if (!argument) {
      return { action: "invalid", message: "网页流程后需要 HTTPS 网页地址。" };
    }
    return { action: "web-workflow", url: argument.split(/\s+/u)[0] };
  }
  if (["导入状态", "import-status", "importstatus"].includes(lower)) {
    if (!JOB_ID_PATTERN.test(argument)) {
      return { action: "invalid", message: "导入状态后需要一个有效的任务编号。" };
    }
    return { action: "import-status", jobId: argument.toLocaleLowerCase() };
  }
  return { action: "unknown" };
}

function parseWebUrlAndCriteria(argument) {
  if (!argument) {
    return undefined;
  }
  const [url, ...criteria] = argument.split(/\s+/u);
  if (!url) {
    return undefined;
  }
  return { action: "analyze-web", url, criteriaText: criteria.join(" ").trim() };
}

function parseAccountIds(argument) {
  if (!argument) {
    return undefined;
  }
  const accountIds = argument
    .split(/[\s,，]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (accountIds.length === 0 || accountIds.length > 100 || accountIds.some((value) => value.length > 200)) {
    return "invalid";
  }
  return accountIds;
}
