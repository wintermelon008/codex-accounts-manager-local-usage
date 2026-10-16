"use strict";

const {
  RegistrationCredentialStore,
  createLocalCredentialStore,
  maskCredential,
  normalizeCredential
} = require("./registration-credential-store.cjs");
const { isMiaoicAccountToken } = require("./miaoic-phone-order.cjs");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.miaoicToken.v1";
const DEFAULT_FILE_NAME = "registration-miaoic-token.v1.json";

class MiaoicTokenStore extends RegistrationCredentialStore {
  constructor({ secretStore, backupStore, storeKey = DEFAULT_STORE_KEY } = {}) {
    super({
      secretStore,
      backupStore,
      storeKey,
      missingStoreMessage: "Miaoic Token store requires a secret store",
      emptyMessage: "Miaoic 内部账户标识不能为空",
      validate: (token) => {
        if (!isMiaoicAccountToken(token)) throw new Error("Miaoic 内部账户标识格式无效");
      },
      mask: () => "",
      normalize: normalizeToken
    });
  }

  async snapshot() {
    const token = await this.get();
    return { configured: isMiaoicAccountToken(token), masked: "" };
  }
}

function createLocalMiaoicTokenStore(storageUri) {
  return createLocalCredentialStore(storageUri, DEFAULT_FILE_NAME);
}

function maskMiaoicToken(value) {
  return maskCredential(value);
}

function normalizeToken(value) {
  return normalizeCredential(value);
}

module.exports = {
  DEFAULT_FILE_NAME,
  DEFAULT_STORE_KEY,
  MiaoicTokenStore,
  createLocalMiaoicTokenStore,
  maskMiaoicToken,
  normalizeToken
};
