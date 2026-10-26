"use strict";

const REGISTRATION_PHONE_SOURCES = Object.freeze([
  Object.freeze({
    id: "fivesim",
    displayName: "5SIM",
    websiteUrl: "https://5sim.net",
    service: "openai",
    credentialType: "api-token",
    credentialFlow: Object.freeze({
      kind: "direct-api-token",
      inputLabel: "5SIM API Token",
      storedLabel: "API Token",
      configuredLabel: "API Token 已保存",
      missingLabel: "未保存 API Token",
      summary: "直接使用 5SIM API Token 查询账户和取号。"
    })
  }),
  Object.freeze({
    id: "miaoic",
    displayName: "Miaoic",
    websiteUrl: "http://miaoic.shop/?tab=recv&page=1&size=20",
    purchaseUrl: "https://www.16688.com.cn/shop/S301395",
    service: "manual-sms",
    credentialType: "account-token-cdk",
    credentialFlow: Object.freeze({
      kind: "account-token-with-purchase-cdk",
      inputLabel: "购买次数 CDK",
      accountTokenInputLabel: "已有账户 Token",
      storedLabel: "账户 Token（隐藏）",
      configuredLabel: "账户 Token 已保存（CDK 已兑换）",
      missingLabel: "需购买并兑换次数 CDK",
      summary: "CDK 充入当前账户 Token；取号时使用账户 Token。"
    })
  }),
  Object.freeze({
    id: "future",
    displayName: "Future",
    websiteUrl: "https://sms.futurepixelai.com/docs",
    purchaseUrl: "https://www.16688.com.cn/shop/AIAISHARE",
    service: "manual-sms",
    credentialType: "cdk-session",
    credentialFlow: Object.freeze({
      kind: "purchase-cdk-to-session-token",
      inputLabel: "购买次数 CDK",
      storedLabel: "Session Token",
      configuredLabel: "Session Token 已保存",
      missingLabel: "需购买并兑换 CDK",
      summary: "CDK 兑换 Session Token；取号时使用兑换结果。"
    })
  }),
  Object.freeze({
    id: "sms688",
    displayName: "SMS688",
    websiteUrl: "https://cdk.sms688.cc",
    service: "manual-sms",
    credentialType: "account-api-key",
    credentialFlow: Object.freeze({
      kind: "account-api-key",
      inputLabel: "账户 API Key",
      storedLabel: "账户 API Key",
      configuredLabel: "账户 API Key 已保存",
      missingLabel: "未保存账户 API Key",
      summary: "当前集成直接使用账户 API Key；不要把购买次数 CDK 填到此入口。"
    })
  }),
]);

function getRegistrationPhoneSource(sourceId = "fivesim") {
  const id = String(sourceId ?? "").trim().toLowerCase();
  return REGISTRATION_PHONE_SOURCES.find((source) => source.id === id) || null;
}

function listRegistrationPhoneSources() {
  return REGISTRATION_PHONE_SOURCES.map((source) => ({ ...source }));
}

module.exports = {
  REGISTRATION_PHONE_SOURCES,
  getRegistrationPhoneSource,
  listRegistrationPhoneSources
};
