"use strict";

const TOKEN_KEY = "codexAccounts.bugteam.apiToken.v1";
const STATE_KEY = "codexAccounts.bugteam.order.v1";
const TINGBAI_USERNAME_KEY = "codexAccounts.bugteam.tingbai.username.v1";
const TINGBAI_PASSWORD_KEY = "codexAccounts.bugteam.tingbai.password.v1";
const TINGBAI_STATE_KEY = "codexAccounts.bugteam.tingbai.state.v1";

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

  async getTingbaiCredentials() {
    const [username, password] = await Promise.all([
      this.context.secrets.get(TINGBAI_USERNAME_KEY),
      this.context.secrets.get(TINGBAI_PASSWORD_KEY)
    ]);
    return typeof username === "string" && typeof password === "string" ? { username, password } : undefined;
  }

  async setTingbaiCredentials(username, password) {
    await Promise.all([
      this.context.secrets.store(TINGBAI_USERNAME_KEY, username),
      this.context.secrets.store(TINGBAI_PASSWORD_KEY, password)
    ]);
  }

  async deleteTingbaiCredentials() {
    await Promise.all([
      this.context.secrets.delete(TINGBAI_USERNAME_KEY),
      this.context.secrets.delete(TINGBAI_PASSWORD_KEY)
    ]);
  }

  async getTingbaiState() {
    const value = await this.context.globalState.get(TINGBAI_STATE_KEY);
    return isRecord(value) ? { ...value } : {};
  }

  updateTingbaiState(state) {
    return this.context.globalState.update(TINGBAI_STATE_KEY, isRecord(state) ? { ...state } : {});
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  BugTeamStorage,
  STATE_KEY,
  TOKEN_KEY,
  TINGBAI_PASSWORD_KEY,
  TINGBAI_STATE_KEY,
  TINGBAI_USERNAME_KEY
};
