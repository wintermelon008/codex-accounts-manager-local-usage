"use strict";

// OpenAI 注册流程状态机
// 设计原则：
// - 自动化范围：打开注册会话 → 提交邮箱/密码/姓名/生日 → 下单接码 → 轮询验证码 → 验证码到达后自动提交
// - 人工决策点：号码不可用/验证码超时后，由调用方（UI）决定是否换号或放弃；
//   本模块不包含自动重试/自动换号的循环逻辑，`requestNewPhone` 必须由外部显式调用一次。

const crypto = require("node:crypto");
const { SmsPlatformClient } = require("./sms-platform-client.cjs");

const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE = "openid profile email offline_access";

const STATES = {
  IDLE: "idle",
  STARTING: "starting",
  AWAITING_PHONE_CONFIRM: "awaiting_phone_confirm",
  AWAITING_OTP: "awaiting_otp",
  SUBMITTING_OTP: "submitting_otp",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

class RegistrationSession {
  constructor(options) {
    this.id = crypto.randomUUID();
    this.email = options.email;
    this.password = options.password;
    this.name = options.name || "jdd";
    this.age = options.age || 24;
    this.smsClient = new SmsPlatformClient(options.smsConfig || {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onLog = options.onLog || (() => {});

    this.state = STATES.IDLE;
    this.currentOrder = null;
    this.phoneAttempts = 0;
    this.jar = new Map();
    this.result = null;
    this.error = null;
    this.pollTimer = null;
    this.otpDeadline = null;
  }

  log(level, msg) {
    this.onLog({ level, msg, sessionId: this.id, email: this.email });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.onStateChange({ sessionId: this.id, state, ...extra });
  }

  // 步骤1：自动执行注册流程直到"需要手机号"阶段
  async start() {
    this.setState(STATES.STARTING);
    this.log("info", "开始注册流程");

    try {
      // 这里对接真实的 OpenAI 注册 HTTP 流程（复用已验证的 OAuth 步骤1-2.5）
      // 为保持模块聚焦，实际的 sentinel/oauth 请求细节由 openaiHttpFlow.cjs 提供
      await this._initOAuthSession();
      await this._submitEmailAndPassword();

      this.log("info", "邮箱与密码已提交，准备获取手机号");
      await this._acquirePhoneNumber();
    } catch (error) {
      this._fail(error);
    }
  }

  // 内部：初始化 OAuth 会话（PKCE + cookie jar）
  async _initOAuthSession() {
    this.log("info", "[步骤1] 初始化 OAuth 会话");
    // 实际实现见 openaiHttpFlow.cjs，此处占位以保持接口稳定
  }

  async _submitEmailAndPassword() {
    this.log("info", `[步骤2] 提交邮箱 ${this.email} 与账号信息（姓名=${this.name}，年龄=${this.age}）`);
    // 实际实现见 openaiHttpFlow.cjs
  }

  // 步骤2：下单接码，进入"待确认"状态，等待 UI 层的人工确认或换号操作
  async _acquirePhoneNumber() {
    this.phoneAttempts += 1;
    this.log("info", `正在获取手机号（第 ${this.phoneAttempts} 次尝试）`);

    try {
      const order = await this.smsClient.createOrder({
        productId: this.smsClient.productId,
      });
      this.currentOrder = order;
      this.log("ok", `已获取号码：${order.phone_number}（订单 ${order.id}）`);

      this.setState(STATES.AWAITING_PHONE_CONFIRM, {
        phone: order.phone_number,
        orderId: order.id,
        attempt: this.phoneAttempts,
      });
    } catch (error) {
      this._fail(error);
    }
  }

  // UI 层调用：人工确认使用当前号码，触发向 OpenAI 提交手机号并开始等待验证码
  async confirmPhone() {
    if (this.state !== STATES.AWAITING_PHONE_CONFIRM) {
      throw new Error("当前状态不允许确认手机号");
    }

    this.log("info", `已确认使用号码 ${this.currentOrder.phone_number}，提交至 OpenAI`);

    try {
      // 实际实现见 openaiHttpFlow.cjs：向 OpenAI 提交手机号，触发短信发送
      await this._submitPhoneToOpenAI();

      this.otpDeadline = Date.now() + 90000;
      this.setState(STATES.AWAITING_OTP, {
        phone: this.currentOrder.phone_number,
        orderId: this.currentOrder.id,
        deadline: this.otpDeadline,
      });

      this._startOtpPolling();
    } catch (error) {
      this._fail(error);
    }
  }

  async _submitPhoneToOpenAI() {
    this.log("info", "向 OpenAI 提交手机号");
    // 实际实现见 openaiHttpFlow.cjs
  }

  // 自动轮询验证码（非自动换号，仅检测到达状态）
  _startOtpPolling() {
    const poll = async () => {
      if (this.state !== STATES.AWAITING_OTP) {
        return;
      }

      if (Date.now() > this.otpDeadline) {
        this.log("warn", "等待验证码超时（90s）");
        this.setState(STATES.AWAITING_PHONE_CONFIRM, {
          phone: this.currentOrder.phone_number,
          orderId: this.currentOrder.id,
          attempt: this.phoneAttempts,
          timedOut: true,
        });
        return;
      }

      try {
        const result = await this.smsClient.pollOnce(this.currentOrder.id);
        if (result.status === "OTP_RECEIVED") {
          this.log("ok", `收到验证码：${result.code}`);
          await this._submitOtp(result.code);
          return;
        }
      } catch (error) {
        this.log("warn", `轮询验证码出错：${error.message}`);
      }

      this.pollTimer = setTimeout(poll, 4000);
    };

    poll();
  }

  async _submitOtp(code) {
    this.setState(STATES.SUBMITTING_OTP, { code });
    this.log("info", "提交验证码到 OpenAI");

    try {
      // 实际实现见 openaiHttpFlow.cjs：提交验证码，完成 OAuth 授权，换取 refresh_token
      const result = await this._completeOAuthFlow(code);
      await this.smsClient.finishOrder(this.currentOrder.id);

      this.result = result;
      this.setState(STATES.COMPLETED, { result });
      this.log("ok", "注册流程完成");
    } catch (error) {
      this._fail(error);
    }
  }

  async _completeOAuthFlow(code) {
    this.log("info", `完成 OAuth 授权（验证码 ${code}）`);
    // 实际实现见 openaiHttpFlow.cjs
    return {
      email: this.email,
      password: this.password,
    };
  }

  // UI 层调用：人工请求换号（唯一允许触发新一轮下单的入口，非自动循环）
  async requestNewPhone(maxAttempts = 25) {
    if (![STATES.AWAITING_PHONE_CONFIRM, STATES.AWAITING_OTP].includes(this.state)) {
      throw new Error("当前状态不允许换号");
    }

    if (this.phoneAttempts >= maxAttempts) {
      this._fail(new Error(`已达到最大换号次数（${maxAttempts}），流程中断`));
      return;
    }

    this._stopPolling();

    if (this.currentOrder) {
      try {
        await this.smsClient.cancelOrder(this.currentOrder.id);
        this.log("info", `已取消订单 ${this.currentOrder.id}`);
      } catch (error) {
        this.log("warn", `取消订单失败：${error.message}`);
      }
    }

    await this._acquirePhoneNumber();
  }

  // UI 层调用：人工放弃流程
  cancel() {
    this._stopPolling();

    if (this.currentOrder) {
      this.smsClient.cancelOrder(this.currentOrder.id).catch(() => undefined);
    }

    this.setState(STATES.CANCELLED);
    this.log("info", "用户取消注册流程");
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _fail(error) {
    this._stopPolling();
    this.error = error;
    this.setState(STATES.FAILED, { error: error.message });
    this.log("error", `注册失败：${error.message}`);
  }
}

module.exports = { RegistrationSession, STATES };
