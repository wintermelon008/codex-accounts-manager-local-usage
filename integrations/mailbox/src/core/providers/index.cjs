"use strict";

const { assertMailboxProvider } = require("../provider.cjs");

class MailboxProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider) {
    const normalized = assertMailboxProvider(provider);
    if (this.providers.has(normalized.id)) {
      throw new Error(`Mailbox provider '${normalized.id}' is already registered`);
    }
    this.providers.set(normalized.id, normalized);
    return normalized;
  }

  get(id) {
    return this.providers.get(id);
  }

  list() {
    return [...this.providers.values()];
  }
}

module.exports = { MailboxProviderRegistry };
