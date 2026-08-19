import { normalizeWebUrl } from "./webPage.mjs";

export const WEB_WORKFLOW_SCHEMA = "feishu-assistant-web-workflow/v1";
export const PAGE_ANALYSIS_SCHEMA = "feishu-assistant-page-analysis/v1";

export const WEB_ACTIONS = Object.freeze(["open", "click", "fill", "wait", "copy", "submit", "note"]);

const SENSITIVE_ACTIONS = new Set(["fill", "submit"]);
const MAX_TEXT_LENGTH = 1_000;

export function normalizeCriteria(input) {
  const source = typeof input === "string" ? parseCriteriaText(input) : input && typeof input === "object" ? input : {};
  const plan = nonempty(source.plan)?.toLocaleLowerCase();
  const phoneVerified =
    source.phoneVerified === true || source.phoneVerified === false ? source.phoneVerified : undefined;
  const inStock = source.inStock === false ? false : true;
  const maxPriceFen = nonNegativeInteger(source.maxPriceFen);
  return {
    plan: plan || undefined,
    phoneVerified,
    inStock,
    maxPriceFen,
    sort: "price_asc"
  };
}

export function parseCriteriaText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const lowered = text.toLocaleLowerCase();
  const criteria = {};
  if (/(?:free|免费)/iu.test(lowered)) {
    criteria.plan = "free";
  }
  if (/(?:接码|已验证手机|手机验证|phone\s*verified|verified\s*phone)/iu.test(lowered)) {
    criteria.phoneVerified = true;
  }
  if (/(?:不限库存|无库存限制)/iu.test(lowered)) {
    criteria.inStock = false;
  } else if (/(?:有库存|现货|in\s*stock)/iu.test(lowered)) {
    criteria.inStock = true;
  }
  const priceMatch = lowered.match(
    /(?:最高|不超过|不高于|低于|少于|under|below)\s*(\d+(?:\.\d+)?)\s*(?:元|cny|rmb)?/iu
  );
  if (priceMatch?.[1]) {
    const amount = Number(priceMatch[1]);
    if (Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER / 100) {
      criteria.maxPriceFen = Math.round(amount * 100);
    }
  }
  return criteria;
}

export function normalizePageAnalysis(value, fallback = {}) {
  const record = asRecord(value) ? value : {};
  const sourceUnavailable = fallback.siteStatus === "unavailable" || record.siteStatus === "unavailable";
  const products =
    !sourceUnavailable && Array.isArray(record.products)
      ? record.products.slice(0, 100).map(normalizeProduct).filter(Boolean)
      : [];
  const instructions =
    !sourceUnavailable && Array.isArray(record.instructions)
      ? record.instructions
          .slice(0, 100)
          .map(normalizeInstruction)
          .filter(Boolean)
          .sort((left, right) => left.order - right.order)
      : [];
  const warnings = stringList(record.warnings, 30);
  if (sourceUnavailable && fallback.unavailableReason) {
    warnings.unshift(boundedString(fallback.unavailableReason));
  }
  const siteStatus = sourceUnavailable
    ? "unavailable"
    : ["available", "unavailable", "unknown"].includes(record.siteStatus)
      ? record.siteStatus
      : (fallback.siteStatus ?? "unknown");
  return {
    schema: PAGE_ANALYSIS_SCHEMA,
    title: boundedString(record.title) ?? boundedString(fallback.title) ?? "",
    siteStatus,
    unavailableReason: boundedString(record.unavailableReason) ?? boundedString(fallback.unavailableReason),
    products,
    instructions,
    warnings: [...new Set(warnings.filter(Boolean))].slice(0, 30),
    requiresBrowser: record.requiresBrowser === true || fallback.requiresBrowser === true
  };
}

export function rankProducts(products, criteriaInput) {
  const criteria = normalizeCriteria(criteriaInput);
  const candidates = (Array.isArray(products) ? products : [])
    .filter((product) => matchesCriteria(product, criteria))
    .sort((left, right) => {
      const leftPrice = left.priceFen ?? Number.MAX_SAFE_INTEGER;
      const rightPrice = right.priceFen ?? Number.MAX_SAFE_INTEGER;
      if (leftPrice !== rightPrice) {
        return leftPrice - rightPrice;
      }
      const leftStock = left.stockCount ?? -1;
      const rightStock = right.stockCount ?? -1;
      return rightStock - leftStock;
    });
  return { criteria, candidates };
}

export function buildWorkflowPlan(snapshot, analysis, criteriaInput, saved = undefined) {
  const ranked = rankProducts(analysis.products, criteriaInput);
  const instructions = analysis.instructions;
  const requiresPayment =
    instructions.some((step) => step.action === "submit") || instructions.some((step) => step.requiresConfirmation);
  return {
    schema: WEB_WORKFLOW_SCHEMA,
    url: snapshot.url,
    title: analysis.title || snapshot.title,
    siteStatus: analysis.siteStatus,
    unavailableReason: analysis.unavailableReason,
    criteria: ranked.criteria,
    candidates: ranked.candidates,
    selected: ranked.candidates[0],
    instructions,
    requiresBrowser: analysis.requiresBrowser || snapshot.requiresBrowser,
    requiresPayment,
    warnings: [...new Set([...analysis.warnings, ...(saved?.warnings ?? [])])].slice(0, 30),
    savedAt: saved?.updatedAt,
    analyzedAt: new Date().toISOString()
  };
}

export function normalizeStoredWorkflow(value) {
  const record = asRecord(value) ? value : {};
  let url;
  try {
    url = normalizeWebUrl(record.url);
  } catch {
    url = undefined;
  }
  if (!url || record.schema !== WEB_WORKFLOW_SCHEMA) {
    throw new Error("网页流程记录格式无效。");
  }
  const analysis = normalizePageAnalysis(record.analysis, {
    title: record.title,
    requiresBrowser: record.requiresBrowser,
    siteStatus: record.siteStatus,
    unavailableReason: record.unavailableReason
  });
  const ranked = rankProducts(analysis.products, record.criteria);
  const requiresPayment =
    analysis.instructions.some((step) => step.action === "submit") ||
    analysis.instructions.some((step) => step.requiresConfirmation);
  return {
    schema: WEB_WORKFLOW_SCHEMA,
    url,
    title: analysis.title,
    siteStatus: analysis.siteStatus,
    unavailableReason: analysis.unavailableReason,
    requiresBrowser: analysis.requiresBrowser,
    criteria: ranked.criteria,
    analysis,
    candidates: ranked.candidates,
    selected: ranked.candidates[0],
    instructions: analysis.instructions,
    requiresPayment,
    warnings: analysis.warnings,
    updatedAt: nonempty(record.updatedAt) ?? new Date().toISOString()
  };
}

export function publicWorkflowRecord(record) {
  const normalized = normalizeStoredWorkflow(record);
  return {
    schema: normalized.schema,
    url: normalized.url,
    title: normalized.title,
    siteStatus: normalized.siteStatus,
    unavailableReason: normalized.unavailableReason,
    requiresBrowser: normalized.requiresBrowser,
    criteria: normalized.criteria,
    candidates: normalized.candidates,
    selected: normalized.selected,
    instructions: normalized.instructions,
    requiresPayment: normalized.requiresPayment,
    warnings: normalized.warnings,
    updatedAt: normalized.updatedAt
  };
}

function matchesCriteria(product, criteria) {
  if (!product || (criteria.inStock && product.inStock !== true)) {
    return false;
  }
  if (criteria.plan && !matchesPlan(product, criteria.plan)) {
    return false;
  }
  if (criteria.phoneVerified === true && product.phoneVerified !== true) {
    return false;
  }
  if (criteria.phoneVerified === false && product.phoneVerified === true) {
    return false;
  }
  if (
    criteria.maxPriceFen !== undefined &&
    (product.priceFen === undefined || product.priceFen > criteria.maxPriceFen)
  ) {
    return false;
  }
  return product.priceFen !== undefined;
}

function matchesPlan(product, plan) {
  const values = [product.plan, product.name, ...(product.features ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return plan === "free" ? values.includes("free") || values.includes("免费") : values.includes(plan);
}

function normalizeProduct(value) {
  if (!asRecord(value)) {
    return undefined;
  }
  const name = boundedString(value.name) ?? boundedString(value.id);
  if (!name) {
    return undefined;
  }
  const priceFen = nullableNonNegativeInteger(value.priceFen);
  const stockCount = nullableNonNegativeInteger(value.stockCount);
  return {
    id: boundedString(value.id) ?? name,
    name,
    plan: boundedString(value.plan)?.toLocaleLowerCase(),
    priceFen,
    currency: boundedString(value.currency)?.toUpperCase() ?? "CNY",
    inStock: value.inStock === true,
    stockCount,
    phoneVerified: value.phoneVerified === true || value.phoneVerified === false ? value.phoneVerified : null,
    features: stringList(value.features, 20),
    purchaseUrl: safeUrl(value.purchaseUrl),
    evidence: normalizeEvidence(value.evidence)
  };
}

function normalizeInstruction(value) {
  if (!asRecord(value) || !WEB_ACTIONS.includes(value.action)) {
    return undefined;
  }
  const action = value.action;
  const target = boundedString(value.target);
  if (!target) {
    return undefined;
  }
  const sensitive =
    value.sensitive === true ||
    (SENSITIVE_ACTIONS.has(action) &&
      /password|token|secret|cookie|session|authorization|api[-_ ]?key|验证码|密钥|凭据|登录密码|邮箱密码/iu.test(
        `${target} ${value.value ?? ""}`
      ));
  return {
    order: Number.isInteger(value.order) && value.order >= 0 ? value.order : 0,
    action,
    target,
    value: sensitive ? null : (boundedString(value.value) ?? null),
    sensitive,
    requiresConfirmation: value.requiresConfirmation === true || action === "submit" || sensitive,
    evidence: sensitive ? [] : normalizeEvidence(value.evidence).slice(0, 3)
  };
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 5)
    .map((item) => {
      if (!asRecord(item)) {
        return undefined;
      }
      const quote = boundedString(item.quote);
      const source = boundedString(item.source);
      return quote && source ? { quote, source } : undefined;
    })
    .filter(Boolean);
}

function stringList(value, limit) {
  return Array.isArray(value)
    ? value
        .map((item) => boundedString(item))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function safeUrl(value) {
  const text = boundedString(value);
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2_048
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const redacted = normalized.replace(
    /((?:bearer\s+|access[_ -]?token[=: ]+|refresh[_ -]?token[=: ]+|password[=: ]+|secret[=: ]+|api[_ -]?key[=: ]+))[^\s,;]+/giu,
    "$1[redacted]"
  );
  return redacted ? redacted.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function nullableNonNegativeInteger(value) {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

function asRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
