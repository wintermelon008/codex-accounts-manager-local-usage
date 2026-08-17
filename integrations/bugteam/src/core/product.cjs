"use strict";

function selectOneHourProduct(products) {
  if (!Array.isArray(products)) {
    throw new Error("BugTeam 商品目录格式无效");
  }
  const candidates = products
    .filter((product) => product && typeof product === "object" && !Array.isArray(product))
    .map(normalizeProduct)
    .filter((product) => product.code && product.billingBaseSeconds > 0)
    .sort((left, right) => Math.abs(left.billingBaseSeconds - 3600) - Math.abs(right.billingBaseSeconds - 3600));
  const product = candidates.find((candidate) => Math.abs(candidate.billingBaseSeconds - 3600) <= 60);
  if (!product) {
    throw new Error("BugTeam 商品目录中没有找到基准有效期约 1 小时的商品");
  }
  return product;
}

function normalizeProduct(product) {
  return {
    code: readString(product.code),
    name: readString(product.name) ?? readString(product.product_name) ?? readString(product.code) ?? "1h OAuth",
    priceFen: finiteNonNegative(product.price_fen),
    billingBaseSeconds: finiteNonNegative(product.billing_base_seconds),
    raw: undefined
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

module.exports = { selectOneHourProduct, normalizeProduct };
