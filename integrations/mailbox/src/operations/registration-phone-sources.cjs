"use strict";

const REGISTRATION_PHONE_SOURCES = Object.freeze([
  Object.freeze({
    id: "liye",
    displayName: "LIYE",
    websiteUrl: "https://liye.5x20.cn",
    service: "chatai",
    credentialType: "key"
  }),
  Object.freeze({
    id: "fivesim",
    displayName: "5SIM",
    websiteUrl: "https://5sim.net",
    service: "openai",
    credentialType: "api-token"
  })
]);

function getRegistrationPhoneSource(sourceId = "liye") {
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
