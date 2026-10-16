"use strict";

const REGISTRATION_PHONE_SOURCES = Object.freeze([
  Object.freeze({
    id: "fivesim",
    displayName: "5SIM",
    websiteUrl: "https://5sim.net",
    service: "openai",
    credentialType: "api-token"
  }),
  Object.freeze({
    id: "miaoic",
    displayName: "Miaoic",
    websiteUrl: "http://miaoic.shop/?tab=recv&page=1&size=20",
    purchaseUrl: "https://www.16688.com.cn/shop/S301395",
    service: "manual-sms",
    credentialType: "cdk"
  }),
  Object.freeze({
    id: "future",
    displayName: "Future",
    websiteUrl: "https://sms.futurepixelai.com/docs",
    purchaseUrl: "https://www.16688.com.cn/shop/AIAISHARE",
    service: "manual-sms",
    credentialType: "cdk"
  }),
  Object.freeze({
    id: "sms688",
    displayName: "SMS688",
    websiteUrl: "https://cdk.sms688.cc",
    service: "manual-sms",
    credentialType: "api-key"
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
