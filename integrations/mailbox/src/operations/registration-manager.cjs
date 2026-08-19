"use strict";

// 注册管理器：管理多个并发注册会话（浏览器自动填表 + 手动号码/验证码输入）。
// 不与任何接码/短信平台通信；号码与验证码完全来自使用者的手动粘贴。

const EventEmitter = require("node:events");
const { RegistrationSession, STATES } = require("./registration-flow.cjs");

class RegistrationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.maxConcurrent = options.maxConcurrent || 3;
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

  // 使用者从自己的接码平台手动复制号码后调用。
  async submitPhoneNumber(sessionId, phone) {
    const session = this._get(sessionId);
    return session.submitPhoneNumber(phone);
  }

  // 使用者从自己的接码平台手动复制验证码后调用。
  async submitVerificationCode(sessionId, code) {
    const session = this._get(sessionId);
    return session.submitVerificationCode(code);
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
      phoneInputCount: session.phoneInputCount,
      result: session.result,
      error: session.error?.message,
    };
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      email: s.email,
      state: s.state,
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
