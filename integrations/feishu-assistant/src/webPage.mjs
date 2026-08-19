const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT_LENGTH = 80_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_LINKS = 100;

export function normalizeWebUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("网页地址不能为空。");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("网页地址无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2_048) {
    throw new Error("网页地址必须是长度有限且不带账号密码的 HTTPS 地址。");
  }
  url.hash = "";
  return url.toString();
}

export async function fetchWebPageSnapshot(url, options = {}) {
  const normalizedUrl = normalizeWebUrl(url);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时不支持网页抓取。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(normalizedUrl, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response?.ok) {
      throw new Error(`网页抓取失败（HTTP ${response?.status ?? "?"}）。`);
    }
    const finalUrl = normalizeWebUrl(response.url || normalizedUrl);
    const contentLength = Number(response.headers?.get?.("content-length"));
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("网页内容过大，已停止分析。");
    }
    const html = await readResponseText(response, maxBytes);
    return createPageSnapshot({ url: finalUrl, html, fetchedAt: new Date().toISOString() });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("网页抓取超时。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createPageSnapshot({ url, html, fetchedAt = new Date().toISOString() }) {
  const normalizedUrl = normalizeWebUrl(url);
  const source = typeof html === "string" ? html : "";
  const title = extractTitle(source);
  const text = htmlToText(source).slice(0, DEFAULT_MAX_TEXT_LENGTH);
  const links = extractLinks(source, normalizedUrl);
  const scriptSources = extractScriptSources(source, normalizedUrl);
  const structuredData = extractStructuredData(source);
  const parking = detectParkingPage(title, text, source);
  const requiresBrowser = !parking && (text.length < 240 || /(?:id=["'](?:app|root)|__next|nuxt|vite)/iu.test(source));
  return {
    schema: "feishu-assistant-page-snapshot/v1",
    url: normalizedUrl,
    title,
    text,
    links,
    scriptSources,
    structuredData,
    requiresBrowser,
    siteStatus: parking ? "unavailable" : text.length > 0 ? "available" : "unknown",
    unavailableReason: parking ? "页面当前是域名停放页或站点占位页。" : undefined,
    fetchedAt
  };
}

async function readResponseText(response, maxBytes) {
  if (typeof response.arrayBuffer !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("网页内容过大，已停止分析。");
    }
    return text;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error("网页内容过大，已停止分析。");
  }
  return bytes.toString("utf8");
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
  return decodeEntities(stripTags(match?.[1] ?? ""))
    .trim()
    .slice(0, 500);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<\/(?:p|div|section|article|header|footer|main|h[1-6]|li|tr|br|dt|dd|pre)>/giu, "\n")
      .replace(/<[^>]+>/gu, " ")
  )
    .split("\n")
    .map((line) => line.replace(/[\t\f\r ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripTags(value) {
  return value.replace(/<[^>]+>/gu, " ");
}

function extractLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const href = safeAbsoluteUrl(match[1], baseUrl);
    if (!href) {
      continue;
    }
    const label = decodeEntities(stripTags(match[2])).replace(/\s+/gu, " ").trim().slice(0, 300);
    if (!links.some((item) => item.url === href)) {
      links.push({ url: href, label });
    }
    if (links.length >= MAX_LINKS) {
      break;
    }
  }
  return links;
}

function extractScriptSources(html, baseUrl) {
  const sources = [];
  const pattern = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/giu;
  for (const match of html.matchAll(pattern)) {
    const source = safeAbsoluteUrl(match[1], baseUrl);
    if (source && !sources.includes(source)) {
      sources.push(source);
    }
    if (sources.length >= MAX_LINKS) {
      break;
    }
  }
  return sources;
}

function extractStructuredData(html) {
  const values = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      values.push(sanitizeStructuredData(value));
    } catch {
      // A malformed JSON-LD block is only an extraction miss, not a page failure.
    }
    if (values.length >= 20) {
      break;
    }
  }
  return values;
}

function sanitizeStructuredData(value, depth = 0) {
  if (depth > 5 || value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, 2_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeStructuredData(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key.slice(0, 200), sanitizeStructuredData(item, depth + 1)])
    );
  }
  return undefined;
}

function detectParkingPage(title, text, html) {
  const sample = `${title}\n${text}\n${html.slice(0, 20_000)}`.toLocaleLowerCase();
  return /(?:domain is for sale|domain name parking|parkweb|lander_system|godaddy|buy this domain|domain may be for sale)/iu.test(
    sample
  );
}

function safeAbsoluteUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, entity) => {
    const lowered = entity.toLocaleLowerCase();
    if (lowered in named) {
      return named[lowered];
    }
    if (lowered.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(lowered.slice(2), 16), whole);
    }
    if (lowered.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(lowered.slice(1), 10), whole);
    }
    return whole;
  });
}

function decodeCodePoint(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : fallback;
}
