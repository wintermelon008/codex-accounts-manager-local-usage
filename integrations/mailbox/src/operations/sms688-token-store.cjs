"use strict";

const {
  RegistrationCredentialStore,
  createLocalCredentialStore,
  maskCredential,
  normalizeCredential
} = require("./registration-credential-store.cjs");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.sms688Token.v1";
const DEFAULT_FILE_NAME = "registration-sms688-token.v1.json";

class Sms688TokenStore extends RegistrationCredentialStore {
  constructor({ secretStore, backupStore, storeKey = DEFAULT_STORE_KEY } = {}) {
    super({
      secretStore,
      backupStore,
      storeKey,
      missingStoreMessage: "SMS688 API Key store requires a secret store",
      emptyMessage: "请填写 SMS688 API Key",
      validate: (token) => {
        if (token.length > 2048) throw new Error("SMS688 API Key 过长");
      },
      mask: maskSms688Token,
      normalize: normalizeToken
    });
  }
}

function createLocalSms688TokenStore(storageUri) {
  return createLocalCredentialStore(storageUri, DEFAULT_FILE_NAME);
}

function maskSms688Token(value) {
  return maskCredential(value);
}

function normalizeToken(value) {
  return normalizeCredential(value);
}

module.exports = {
  DEFAULT_FILE_NAME,
  DEFAULT_STORE_KEY,
  Sms688TokenStore,
  createLocalSms688TokenStore,
  maskSms688Token,
  normalizeToken
};
