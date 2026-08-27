"use strict";

const { assertMailboxProvider } = require("../core/provider.cjs");

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 5 * 1000;

class RegistrationEmailCodeWatcher {
  constructor({
    pool,
    providers,
    now = () => Date.now(),
    sleep = delay,
    windowMs = DEFAULT_WINDOW_MS,
    pollMs = DEFAULT_POLL_MS,
    onStateChange = () => {}
  } = {}) {
    if (!pool || typeof pool.listMetadata !== "function" || typeof pool.getAccount !== "function") {
      throw new TypeError("Registration email watcher requires a mailbox pool");
    }
    if (!providers || typeof providers.get !== "function") {
      throw new TypeError("Registration email watcher requires mailbox providers");
    }
    this.pool = pool;
    this.providers = providers;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.sleep = typeof sleep === "function" ? sleep : delay;
    this.windowMs = normalizePositive(windowMs, DEFAULT_WINDOW_MS);
    this.pollMs = normalizePositive(pollMs, DEFAULT_POLL_MS);
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this.state = createEmailCodeState();
    this.controller = undefined;
    this.promise = undefined;
    this.active = false;
    this.refreshing = false;
  }

  isRunning() {
    return this.active || this.refreshing;
  }

  snapshot() {
    return { ...this.state };
  }

  start(email, options = {}) {
    if (this.promise) {
      return this.promise;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.active = true;
    this.state = createEmailCodeState({
      phase: "searching",
      running: true,
      message: "正在查询最近 30 分钟内的邮箱验证码…"
    });
    this.publish();

    const promise = (async () => {
      try {
        return await this.run(email, controller.signal, options);
      } finally {
        this.finish(controller);
      }
    })();
    this.promise = promise;
    return promise;
  }

  // GPT 手动注册进入外部浏览器后只做一次邮箱查询；持续查询仍由用户
  // 点击“查询邮件/重新查询”显式启动，避免浏览器交接后长期占用 provider。
  queryOnce(email, options = {}) {
    if (this.promise) {
      return this.promise;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.active = true;
    this.state = createEmailCodeState({
      phase: "searching",
      running: true,
      message: "正在自动查询一次最近 30 分钟内的邮箱验证码…"
    });
    this.publish();

    const promise = (async () => {
      try {
        return await this.runOnce(email, controller.signal, options);
      } finally {
        this.finish(controller);
      }
    })();
    this.promise = promise;
    return promise;
  }

  async refresh(email, options = {}) {
    this.refreshing = true;
    try {
      const current = this.promise;
      if (current) {
        this.active = false;
        this.controller?.abort();
        await current.catch(() => undefined);
      }
      return this.start(email, options);
    } finally {
      this.refreshing = false;
    }
  }

  stop() {
    if (!this.active && !this.promise) {
      return false;
    }
    this.active = false;
    this.controller?.abort();
    this.setState({
      phase: "cancelled",
      running: false,
      message: "邮箱验证码查询已停止",
      error: ""
    });
    return true;
  }

  async run(email, signal, { ignoreCode = "", ignoreReceivedAt = "" } = {}) {
    const address = normalizeEmail(email);
    const startedAt = this.now();
    const deadline = startedAt + this.windowMs;
    let mailbox;

    try {
      mailbox = this.findMailbox(address);
      if (!mailbox) {
        return this.fail("未找到已导入的邮箱，请先在 Mailbox 面板导入该邮箱");
      }
      this.setState({
        mailboxId: mailbox.id,
        providerId: mailbox.providerId,
        message: "已匹配邮箱来源，正在查询最近 30 分钟内的验证码…",
        error: ""
      });

      while (!signal.aborted && this.now() <= deadline) {
        const result = await this.queryMailbox(mailbox.id, signal);
        if (signal.aborted) {
          return this.snapshot();
        }

        if (!result.ok) {
          const message = safeError(result.error, "邮箱查询失败");
          this.setState({
            phase: "error",
            error: message,
            message: result.error?.retryable === false ? "邮箱来源凭据不可用，请检查 Mailbox 导入信息" : "邮箱查询失败，将继续重试…"
          });
          if (result.error?.retryable === false) {
            return this.snapshot();
          }
        } else {
          const latest = findLatestRecentEmailCode(result.messages, this.now(), this.windowMs);
          const sameAsIgnored = latest && latest.code === String(ignoreCode || "").trim() &&
            (!ignoreReceivedAt || latest.receivedAt === ignoreReceivedAt);
          if (latest && !sameAsIgnored) {
            this.setState({
              phase: "received",
              running: false,
              code: latest.code,
              receivedAt: latest.receivedAt,
              subject: latest.subject,
              error: "",
              message: "已找到最近 30 分钟内最新的邮箱验证码"
            });
            return this.snapshot();
          }
          this.setState({
            phase: "searching",
            error: "",
            message: "最近 30 分钟内暂无带有效收到时间的邮箱验证码，将继续查询…"
          });
        }

        const remaining = deadline - this.now();
        if (remaining <= 0) {
          break;
        }
        await this.sleep(Math.min(this.pollMs, remaining), signal);
      }

      if (signal.aborted) {
        return this.snapshot();
      }
      return this.finishState({
        phase: "expired",
        message: "最近 30 分钟查询窗口已结束，未找到邮箱验证码"
      });
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        return this.snapshot();
      }
      return this.fail(safeError(error, "邮箱验证码查询失败"));
    }
  }

  async runOnce(email, signal, { ignoreCode = "", ignoreReceivedAt = "" } = {}) {
    const address = normalizeEmail(email);

    try {
      if (signal.aborted) return this.snapshot();
      const mailbox = this.findMailbox(address);
      if (!mailbox) {
        return this.fail("未找到已导入的邮箱，请先在 Mailbox 面板导入该邮箱");
      }
      this.setState({
        mailboxId: mailbox.id,
        providerId: mailbox.providerId,
        message: "已匹配邮箱来源，正在自动查询最近 30 分钟内的验证码…",
        error: ""
      });

      const result = await this.queryMailbox(mailbox.id, signal);
      if (signal.aborted) return this.snapshot();
      if (!result.ok) {
        const message = safeError(result.error, "邮箱查询失败");
        return this.finishState({
          phase: "error",
          error: message,
          message: result.error?.retryable === false
            ? "邮箱来源凭据不可用，请检查 Mailbox 导入信息"
            : "本次邮箱查询失败，请点击“查询邮件”重试"
        });
      }

      const latest = findLatestRecentEmailCode(result.messages, this.now(), this.windowMs);
      const sameAsIgnored = latest && latest.code === String(ignoreCode || "").trim() &&
        (!ignoreReceivedAt || latest.receivedAt === ignoreReceivedAt);
      if (latest && !sameAsIgnored) {
        return this.finishState({
          phase: "received",
          code: latest.code,
          receivedAt: latest.receivedAt,
          subject: latest.subject,
          error: "",
          message: "已找到最近 30 分钟内最新的邮箱验证码"
        });
      }
      return this.finishState({
        phase: "checked",
        error: "",
        message: "已完成一次查询，最近 30 分钟内暂无带有效收到时间的邮箱验证码"
      });
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        return this.snapshot();
      }
      return this.fail(safeError(error, "邮箱验证码查询失败"));
    }
  }

  findMailbox(email) {
    const metadata = this.pool.listMetadata({ includeDisabled: false });
    return metadata.find((mailbox) => String(mailbox.address || "").trim().toLowerCase() === email);
  }

  async queryMailbox(mailboxId, signal) {
    const account = await this.pool.getAccount(mailboxId);
    if (!account) {
      throw new Error("已导入邮箱的凭据不可用");
    }
    const provider = assertMailboxProvider(this.providers.get(account.providerId));
    const result = await provider.query(account, {
      maxMessages: provider.capabilities?.maxMessages,
      signal
    });
    if (!result || typeof result !== "object") {
      throw new Error("邮箱来源返回了无效结果");
    }
    if (typeof this.pool.recordQueryResult === "function") {
      await this.pool.recordQueryResult(mailboxId, result, { historyMode: provider.capabilities?.history });
    }
    return result;
  }

  fail(message) {
    return this.finishState({
      phase: "error",
      error: message,
      message
    });
  }

  finishState(next) {
    this.active = false;
    this.setState({ ...next, running: false });
    return this.snapshot();
  }

  setState(next) {
    this.state = {
      ...this.state,
      ...next,
      running: typeof next.running === "boolean" ? next.running : this.active,
      updatedAt: this.now()
    };
    this.publish();
  }

  publish() {
    try {
      this.onStateChange(this.snapshot());
    } catch {
      // UI state propagation must not affect mailbox polling.
    }
  }

  finish(controller) {
    if (this.controller !== controller) {
      return;
    }
    this.active = false;
    this.controller = undefined;
    this.promise = undefined;
    if (this.state.running) {
      this.setState({ running: false });
    }
  }
}

function createEmailCodeState(overrides = {}) {
  return {
    phase: "idle",
    running: false,
    mailboxId: "",
    providerId: "",
    code: "",
    receivedAt: "",
    subject: "",
    message: "",
    error: "",
    updatedAt: 0,
    ...overrides
  };
}

function findLatestRecentEmailCode(messages, now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  const current = Number(now);
  const cutoff = current - normalizePositive(windowMs, DEFAULT_WINDOW_MS);
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || typeof message !== "object" || !Array.isArray(message.codes)) {
        return undefined;
      }
      const receivedAtMs = Date.parse(message.receivedAt);
      const code = message.codes.find((value) => typeof value === "string" && /^\d{6}$/u.test(value));
      if (!Number.isFinite(receivedAtMs) || receivedAtMs < cutoff || receivedAtMs > current || !code) {
        return undefined;
      }
      return {
        code,
        receivedAt: new Date(receivedAtMs).toISOString(),
        subject: typeof message.subject === "string" ? message.subject : ""
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))[0];
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email) {
    throw new Error("注册邮箱不能为空");
  }
  return email;
}

function normalizePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("Request cancelled");
  error.name = "AbortError";
  return error;
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_WINDOW_MS,
  RegistrationEmailCodeWatcher,
  createEmailCodeState,
  findLatestRecentEmailCode
};
