"use strict";

// 注册管理器：管理多个并发注册会话（页面状态检测 + 人工验证码确认）。
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
  }

  createSession(params) {
    if (!params.email || !params.password) {
      throw new Error("缺少必填参数：email 或 password");
    }

    const session = new RegistrationSession({
      email: params.email,
      password: params.password,
      name: params.name || "jdd",
      age: params.age || 24,
      startOAuthImport: this.startOAuthImport,
      cancelOAuthImport: this.cancelOAuthImport,
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
      phoneInputCount: s.phoneInputCount,
    }));
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

module.exports = { RegistrationManager };
