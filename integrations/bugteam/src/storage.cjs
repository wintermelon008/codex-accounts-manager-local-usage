"use strict";

const TOKEN_KEY = "codexAccounts.bugteam.apiToken.v1";
const STATE_KEY = "codexAccounts.bugteam.order.v1";

class BugTeamStorage {
  constructor(context) {
    this.context = context;
  }

  getToken() {
    return this.context.secrets.get(TOKEN_KEY);
  }

  setToken(token) {
    return this.context.secrets.store(TOKEN_KEY, token);
  }

  deleteToken() {
    return this.context.secrets.delete(TOKEN_KEY);
  }

  async getOrder() {
    const value = await this.context.globalState.get(STATE_KEY);
    return isRecord(value) ? { ...value } : {};
  }

  updateOrder(order) {
    return this.context.globalState.update(STATE_KEY, isRecord(order) ? { ...order } : {});
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = { BugTeamStorage, STATE_KEY, TOKEN_KEY };
