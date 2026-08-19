"use strict";

// OpenAI 注册表单自动填充助手（Playwright 驱动真实浏览器）
//
// 设计边界（明确且不允许扩大）：
// - 本模块不与任何接码/短信平台通信，不做号码或验证码的自动获取、轮询、换号。
// - 手机号与短信验证码完全由使用者在外部（自己的接码平台账号）手动查看，
//   再通过 submitPhoneNumber() / submitVerificationCode() 显式粘贴提交。
// - 每次“换号”都是使用者的独立决定：调用方需要先调用 resetForNewPhone()，
//   再重新调用 submitPhoneNumber()；本模块不会自动重复此过程。

const crypto = require("node:crypto");
const { chromium } = require("playwright");

const REGISTER_URL = "https://auth.openai.com/create-account";

const STATES = {
  IDLE: "idle",
  STARTING: "starting",
  AWAITING_ACCOUNT_DETAILS: "awaiting_account_details",
  AWAITING_PHONE_INPUT: "awaiting_phone_input",
  SUBMITTING_PHONE: "submitting_phone",
  AWAITING_OTP_INPUT: "awaiting_otp_input",
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
    this.onStateChange = options.onStateChange || (() => {});
    this.onLog = options.onLog || (() => {});

    this.state = STATES.IDLE;
    this.browser = null;
    this.page = null;
    this.result = null;
    this.error = null;
    this.phoneInputCount = 0;
  }

  log(level, msg) {
    this.onLog({ level, msg, sessionId: this.id, email: this.email });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.onStateChange({ sessionId: this.id, state, ...extra });
  }

  // 打开真实浏览器，填好邮箱/密码/姓名/生日，走到"需要手机号"这一步。
  async start() {
    this.setState(STATES.STARTING);
    this.log("info", "启动浏览器，打开 OpenAI 注册页");

    try {
      this.browser = await chromium.launch({ headless: false });
      const context = await this.browser.newContext();
      this.page = await context.newPage();

      await this.page.goto(REGISTER_URL, { waitUntil: "domcontentloaded" });

      await this._fillAccountDetails();

      this.setState(STATES.AWAITING_PHONE_INPUT, { attempt: this.phoneInputCount });
      this.log("info", "账号信息已提交，等待手动输入手机号");
    } catch (error) {
      await this._fail(error);
    }
  }

  async _fillAccountDetails() {
    this.setState(STATES.AWAITING_ACCOUNT_DETAILS);
    this.log("info", `填写邮箱=${this.email} 姓名=${this.name} 年龄=${this.age}`);

    const page = this.page;
    await page.fill('input[name="email"], input[type="email"]', this.email).catch(() => undefined);
    const continueBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
    if (await continueBtn.count()) {
      await continueBtn.click().catch(() => undefined);
    }

    await page.waitForTimeout(1000);
    await page.fill('input[name="password"], input[type="password"]', this.password).catch(() => undefined);
    await page.fill('input[name="name"], input[name="full_name"]', this.name).catch(() => undefined);

    const submitBtn = page.locator('button[type="submit"]').first();
    if (await submitBtn.count()) {
      await submitBtn.click().catch(() => undefined);
    }
    await page.waitForTimeout(1000);
  }

  // 使用者手动从自己的接码平台复制号码后调用；本方法只做“填入并提交”。
  async submitPhoneNumber(phone) {
    if (this.state !== STATES.AWAITING_PHONE_INPUT) {
      throw new Error("当前状态不接受手机号输入");
    }
    if (!phone || typeof phone !== "string") {
      throw new Error("手机号不能为空");
    }

    this.phoneInputCount += 1;
    this.setState(STATES.SUBMITTING_PHONE, { phone, attempt: this.phoneInputCount });
    this.log("info", `提交手机号 ${phone}（第 ${this.phoneInputCount} 次输入）`);

    try {
      const page = this.page;
      await page.fill('input[name="phone_number"], input[type="tel"]', phone);
      const submitBtn = page.locator('button[type="submit"], button:has-text("Send code")').first();
      if (await submitBtn.count()) {
        await submitBtn.click();
      }
      await page.waitForTimeout(1500);

      const rejected = await this._detectPhoneRejected();
      if (rejected) {
        this.log("warn", `号码被拒绝：${rejected}`);
        this.setState(STATES.AWAITING_PHONE_INPUT, {
          attempt: this.phoneInputCount,
          rejected: rejected,
        });
        return { accepted: false, reason: rejected };
      }

      this.setState(STATES.AWAITING_OTP_INPUT, { phone, attempt: this.phoneInputCount });
      this.log("ok", "短信已发送，等待手动输入验证码");
      return { accepted: true };
    } catch (error) {
      await this._fail(error);
      throw error;
    }
  }

  async _detectPhoneRejected() {
    const page = this.page;
    const errorLocator = page.locator('[role="alert"], .error-message, [data-testid="error"]').first();
    if (await errorLocator.count()) {
      const text = await errorLocator.textContent().catch(() => "");
      if (text && text.trim()) {
        return text.trim();
      }
    }
    return null;
  }

  // 使用者手动从自己的接码平台复制验证码后调用；本方法只做“填入并提交”。
  async submitVerificationCode(code) {
    if (this.state !== STATES.AWAITING_OTP_INPUT) {
      throw new Error("当前状态不接受验证码输入");
    }
    if (!code || typeof code !== "string") {
      throw new Error("验证码不能为空");
    }

    this.setState(STATES.SUBMITTING_OTP, { code });
    this.log("info", "提交验证码");

    try {
      const page = this.page;
      await page.fill('input[name="code"], input[name="otp"], input[type="tel"][maxlength]', code);
      const submitBtn = page.locator('button[type="submit"], button:has-text("Verify")').first();
      if (await submitBtn.count()) {
        await submitBtn.click();
      }
      await page.waitForTimeout(2000);

      const errorText = await this._detectPhoneRejected();
      if (errorText) {
        this.log("warn", `验证码校验失败：${errorText}`);
        this.setState(STATES.AWAITING_OTP_INPUT, { rejected: errorText });
        return { accepted: false, reason: errorText };
      }

      this.result = { email: this.email, password: this.password };
      this.setState(STATES.COMPLETED, { result: this.result });
      this.log("ok", "注册流程完成");
      await this._closeBrowser();
      return { accepted: true, result: this.result };
    } catch (error) {
      await this._fail(error);
      throw error;
    }
  }

  // 使用者决定换号：仅重置到“等待输入手机号”，不触发任何自动重试。
  resetForNewPhone() {
    if (![STATES.AWAITING_PHONE_INPUT, STATES.AWAITING_OTP_INPUT].includes(this.state)) {
      throw new Error("当前状态不允许更换手机号");
    }
    this.log("info", "使用者请求更换手机号，等待新号码输入");
    this.setState(STATES.AWAITING_PHONE_INPUT, { attempt: this.phoneInputCount });
  }

  async cancel() {
    this.log("info", "使用者取消注册流程");
    await this._closeBrowser();
    this.setState(STATES.CANCELLED);
  }

  async _fail(error) {
    await this._closeBrowser();
    this.error = error;
    this.setState(STATES.FAILED, { error: error.message });
    this.log("error", `流程失败：${error.message}`);
  }

  async _closeBrowser() {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.page = null;
    }
  }
}

module.exports = { RegistrationSession, STATES };
