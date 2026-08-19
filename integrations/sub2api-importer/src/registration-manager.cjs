"use strict";

// 注册管理器：管理多个并发注册会话，暴露给 VS Code Extension API

const { RegistrationSession, STATES } = require("./registration-flow.cjs");
const EventEmitter = require("node:events");

class RegistrationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.smsConfig = options.smsConfig || {};
    this.maxConcurrent = options.maxConcurrent || 3;
  }

  // 创建新的注册会话
  createSession(params) {
    if (!params.email || !params.password) {
      throw new Error("缺少必填参数：email 或 password");
    }

    const session = new RegistrationSession({
      email: params.email,
      password: params.password,
      name: params.name || "jdd",
      age: params.age || 24,
      smsConfig: this.smsConfig,
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

  // 启动注册会话
  async startSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }

    const activeCount = Array.from(this.sessions.values()).filter(
      (s) => ![STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED, STATES.IDLE].includes(s.state)
    ).length;

    if (activeCount >= this.maxConcurrent) {
      throw new Error(`并发注册数已达上限（${this.maxConcurrent}）`);
    }

    await session.start();
  }

  // 确认使用当前号码
  async confirmPhone(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    await session.confirmPhone();
  }

  // 换号（由 UI 调用，非自动循环）
  async requestNewPhone(sessionId, maxAttempts = 25) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    await session.requestNewPhone(maxAttempts);
  }

  // 取消会话
  cancelSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.cancel();
  }

  // 获取会话状态
  getSessionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      email: session.email,
      state: session.state,
      phoneAttempts: session.phoneAttempts,
      currentPhone: session.currentOrder?.phone_number,
      orderId: session.currentOrder?.id,
      result: session.result,
      error: session.error?.message,
    };
  }

  // 获取所有会话状态
  getAllSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      email: s.email,
      state: s.state,
      phoneAttempts: s.phoneAttempts,
      currentPhone: s.currentOrder?.phone_number,
    }));
  }

  // 清理已完成/失败的会话
  cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(session.state)) {
      this.sessions.delete(sessionId);
      this.emit("sessionCleaned", { sessionId });
    }
  }

  // 更新接码配置
  updateSmsConfig(config) {
    this.smsConfig = { ...this.smsConfig, ...config };
  }
}

module.exports = { RegistrationManager };
