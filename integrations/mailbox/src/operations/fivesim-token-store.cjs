"use strict";

const {
  RegistrationCredentialStore,
  createLocalCredentialStore,
  maskCredential,
  normalizeCredential
} = require("./registration-credential-store.cjs");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.fivesimToken.v1";
const DEFAULT_FILE_NAME = "registration-fivesim-token.v1.json";

class FiveSimTokenStore extends RegistrationCredentialStore {
  constructor({ secretStore, backupStore, storeKey = DEFAULT_STORE_KEY } = {}) {
    super({
      secretStore,
      backupStore,
      storeKey,
      missingStoreMessage: "5SIM token store requires a secret store",
      emptyMessage: "请填写 5SIM API Token",
      validate: (token) => {
        if (token.length > 2048) throw new Error("5SIM API Token 过长");
      },
      mask: maskFiveSimToken,
      normalize: normalizeToken
    });
  }
}

function createLocalFiveSimTokenStore(storageUri) {
  return createLocalCredentialStore(storageUri, DEFAULT_FILE_NAME);
}

function maskFiveSimToken(value) {
  return maskCredential(value);
}

function normalizeToken(value) {
  return normalizeCredential(value);
}

module.exports = {
  DEFAULT_FILE_NAME,
  DEFAULT_STORE_KEY,
  FiveSimTokenStore,
  createLocalFiveSimTokenStore,
  maskFiveSimToken,
  normalizeToken
};
