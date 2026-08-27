"use strict";

// 注册管理器：管理多个并发注册会话（自动后备流程 + GPT 手动浏览器辅助）。
// 接码平台只提供识别/读取内容，手机号、验证码和最终授权均由用户显式确认。

const EventEmitter = require("node:events");
const { RegistrationSession, STATES } = require("./registration-flow.cjs");

class RegistrationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.maxConcurrent = options.maxConcurrent || 3;
    this.startOAuthImport = typeof options.startOAuthImport === "function" ? options.startOAuthImport : null;
    this.cancelOAuthImport = typeof options.cancelOAuthImport === "function" ? options.cancelOAuthImport : null;
    this.openRegistrationBrowser = typeof options.openRegistrationBrowser === "function" ? options.openRegistrationBrowser : null;
  }

  createSession(params) {
    const importCodex = params.importCodex !== false;
    if (!params.email || (importCodex && !params.password)) {
      throw new Error("缺少必填参数：email 或 password");
    }

    const session = new RegistrationSession({
      email: params.email,
      password: params.password,
      name: params.name || "jdd",
      age: params.age || 24,
      importCodex,
      startOAuthImport: importCodex ? this.startOAuthImport : null,
      cancelOAuthImport: importCodex ? this.cancelOAuthImport : null,
      openRegistrationBrowser: importCodex ? null : this.openRegistrationBrowser,
      onStateChange: (event) => {
        this.emit("stateChange", { sessionId: session.id, ...event });
      },
      onLog: (log) => {
        this.emit("log", { sessionId: session.id, ...log });
      },
    });

    this.sessions.set(session.id, session);
    this.emit("sessionCreated", { sessionId: session.id, email: session.email });

    return session.id;
  }

  async startSession(sessionId) {
    const session = this._get(sessionId);

    const activeCount = Array.from(this.sessions.values()).filter(
      (s) => ![STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED, STATES.IDLE].includes(s.state)
    ).length;

    if (activeCount >= this.maxConcurrent) {
      throw new Error(`并发注册数已达上限（${this.maxConcurrent}）`);
    }

    await session.start();
  }

  // 用户确认面板中的手机号后调用。
  async submitPhoneNumber(sessionId, phone) {
    const session = this._get(sessionId);
    return session.submitPhoneNumber(phone);
  }

  async submitEmailVerificationCode(sessionId, code) {
    const session = this._get(sessionId);
    return session.submitEmailVerificationCode(code);
  }

  // 用户确认面板中的短信验证码后调用。
  async submitVerificationCode(sessionId, code) {
    const session = this._get(sessionId);
    return session.submitVerificationCode(code);
  }

  async authorizeSession(sessionId) {
    const session = this._get(sessionId);
    return session.authorize();
  }

  completeManualRegistration(sessionId) {
    const session = this._get(sessionId);
    return session.completeManualRegistration();
  }

  async acquirePhoneNumber(sessionId, cardCode, options = {}) {
    const session = this._get(sessionId);
    return session.acquirePhoneNumber(cardCode, options);
  }

  async confirmPhoneNumber(sessionId) {
    const session = this._get(sessionId);
    return session.confirmPhoneNumber();
  }

  async replacePhoneNumber(sessionId) {
    const session = this._get(sessionId);
    const result = await session.replacePhoneNumber();
    // 接码平台只换号；注册页面仍回到等待用户手动填写手机号的状态。
    if ([STATES.AWAITING_PHONE_INPUT, STATES.AWAITING_OTP_INPUT].includes(session.state)) {
      session.resetForNewPhone();
    }
    return result;
  }

  async cancelPhoneNumber(sessionId) {
    const session = this._get(sessionId);
    return session.cancelPhoneNumber();
  }

  setEmailCodeState(sessionId, emailCode) {
    const session = this._get(sessionId);
    session.setEmailCodeState(emailCode);
  }

  // 使用者决定换号：仅重置状态，不触发任何自动请求。
  requestNewPhone(sessionId) {
    const session = this._get(sessionId);
    session.resetForNewPhone();
  }

  async cancelSession(sessionId) {
    const session = this._get(sessionId);
    await session.cancel();
  }

  getSessionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      email: session.email,
      state: session.state,
      mode: session.mode,
      importCodex: session.importCodex,
      phoneInputCount: session.phoneInputCount,
      phoneOrder: session.getPhoneOrderState(),
      emailCode: session.getEmailCodeState(),
      result: session.result,
      error: session.error?.message,
      feedback: session.feedback,
      feedbackLevel: session.feedbackLevel,
    };
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      email: s.email,
      state: s.state,
      mode: s.mode,
      importCodex: s.importCodex,
      phoneInputCount: s.phoneInputCount,
    }));
  }

  getSessionRecords() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      email: session.email,
      mode: session.mode,
      importCodex: session.importCodex,
      state: session.state,
      phoneInputCount: session.phoneInputCount,
      name: session.name,
      age: session.age,
      result: persistableResult(session.result),
      error: session.error?.message,
      feedback: session.feedback,
      feedbackLevel: session.feedbackLevel,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    }));
  }

  restoreSessions(records) {
    let added = 0;
    let interrupted = 0;
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id || !record.email) {
        continue;
      }
      if (this.sessions.has(record.id)) {
        continue;
      }

      // Records written before the two-route UI represented the original
      // registration action, which now means registration plus Codex import.
      const importCodex = record.importCodex !== false;
      const session = new RegistrationSession({
        email: record.email,
        password: "",
        name: record.name || "jdd",
        age: record.age || 24,
        importCodex,
        startOAuthImport: importCodex && record.mode === "oauth" ? this.startOAuthImport : null,
        cancelOAuthImport: importCodex && record.mode === "oauth" ? this.cancelOAuthImport : null,
        openRegistrationBrowser: !importCodex ? this.openRegistrationBrowser : null
      });
      session.id = record.id;
      session.oauthOperationId = `registration-oauth:${session.id}`;
      session.importCodex = importCodex;
      session.mode = importCodex && record.mode === "oauth"
        ? "oauth"
        : !importCodex
          ? "manual-browser"
          : "playwright";
      session.phoneInputCount = Number.isFinite(record.phoneInputCount) ? Math.max(0, Math.floor(record.phoneInputCount)) : 0;
      session.result = persistableResult(record.result);
      session.error = typeof record.error === "string" && record.error ? new Error(record.error) : null;
      session.feedback = typeof record.feedback === "string" ? record.feedback : "";
      session.feedbackLevel = typeof record.feedbackLevel === "string" ? record.feedbackLevel : "info";
      session.createdAt = Number.isFinite(record.createdAt) ? record.createdAt : session.createdAt;
      session.updatedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : session.updatedAt;

      const terminal = [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(record.state);
      if (!terminal && record.state !== STATES.IDLE) {
        session.state = STATES.CANCELLED;
        session.feedback = "该注册流程来自其他扩展会话，活动浏览器流程未跨设备恢复；请重新开始";
        session.feedbackLevel = "warning";
        session.updatedAt = Date.now();
        interrupted += 1;
      } else {
        session.state = Object.values(STATES).includes(record.state) ? record.state : STATES.IDLE;
      }

      this.sessions.set(session.id, session);
      added += 1;
    }
    return { added, interrupted };
  }

  cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(session.state)) {
      this.sessions.delete(sessionId);
      this.emit("sessionCleaned", { sessionId });
    }
  }

  _get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    return session;
  }
}

function persistableResult(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  return {
    email: typeof result.email === "string" ? result.email : undefined,
    accountId: typeof result.accountId === "string" ? result.accountId : undefined,
    quotaRefreshed: typeof result.quotaRefreshed === "boolean" ? result.quotaRefreshed : undefined,
    quotaError: typeof result.quotaError === "string" ? result.quotaError.slice(0, 160) : undefined
  };
}

module.exports = { RegistrationManager };
