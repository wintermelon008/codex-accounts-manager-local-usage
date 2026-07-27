"use strict";

const SECRET_PREFIX = "codex-accounts.sub2api-gateway.";

class Sub2ApiGatewaySecretStore {
  constructor(secrets) {
    this.secrets = secrets;
  }

  get(reference) {
    return this.secrets.get(this.key(reference));
  }

  store(reference, value) {
    return this.secrets.store(this.key(reference), value);
  }

  key(reference) {
    return `${SECRET_PREFIX}${reference}`;
  }
}

module.exports = { Sub2ApiGatewaySecretStore };
