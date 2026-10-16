"use strict";

const {
  RegistrationCredentialStore,
  createLocalCredentialStore,
  maskCredential,
  normalizeCredential
} = require("./registration-credential-store.cjs");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.futureToken.v1";
const DEFAULT_FILE_NAME = "registration-future-token.v1.json";

class FutureTokenStore extends RegistrationCredentialStore {
  constructor({ secretStore, backupStore, storeKey = DEFAULT_STORE_KEY } = {}) {
    super({
      secretStore,
      backupStore,
      storeKey,
      missingStoreMessage: "Future Session Token store requires a secret store",
      emptyMessage: "Future 未返回有效 Session Token",
      validate: (token) => {
        if (token.length > 4096) throw new Error("Future Session Token 过长");
      },
      mask: maskFutureToken,
      normalize: normalizeToken
    });
  }
}

function createLocalFutureTokenStore(storageUri) {
  return createLocalCredentialStore(storageUri, DEFAULT_FILE_NAME);
}

function maskFutureToken(value) {
  return maskCredential(value);
}

function normalizeToken(value) {
  return normalizeCredential(value);
}

module.exports = {
  DEFAULT_FILE_NAME,
  DEFAULT_STORE_KEY,
  FutureTokenStore,
  createLocalFutureTokenStore,
  maskFutureToken,
  normalizeToken
};
