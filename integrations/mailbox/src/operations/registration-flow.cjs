"use strict";

// OpenAI 注册表单人工辅助助手（Playwright 只负责打开页面和账号信息表单）。
//
// 设计边界（明确且不允许扩大）：
// - 接码平台只由用户点击“开始取号/重新取号/取消取号”触发；拿到号码后自动读取短信验证码。
// - 接码平台返回的手机号和验证码只用于面板识别/填入，必须由用户确认后才提交注册页面。
// - 邮箱验证码同样必须由用户确认后提交；注册流程不会自动换号或自动点击最终授权。

const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { isDisplayLaunchError, prepareBrowserEnvironment } = require("./browser-mode.cjs");
const { LIYEPhoneOrderSession } = require("./liye-phone-order.cjs");
const { createEmailCodeState } = require("./registration-email-code.cjs");

const REGISTER_URL = "https://chatgpt.com/auth/login";
const REGISTRATION_SESSION_ENDED_ERROR = "OpenAI 返回“会话已结束”页面，当前注册入口没有有效会话；请重新点击“开始注册”后重试";

const STATES = {
  IDLE: "idle",
  STARTING: "starting",
  AWAITING_ACCOUNT_DETAILS: "awaiting_account_details",
  AWAITING_OAUTH: "awaiting_oauth",
  AWAITING_EMAIL_CODE: "awaiting_email_code",
  SUBMITTING_EMAIL_CODE: "submitting_email_code",
  AWAITING_PHONE_INPUT: "awaiting_phone_input",
  SUBMITTING_PHONE: "submitting_phone",
  AWAITING_OTP_INPUT: "awaiting_otp_input",
  SUBMITTING_OTP: "submitting_otp",
  AWAITING_PROFILE: "awaiting_profile",
  SUBMITTING_PROFILE: "submitting_profile",
  AWAITING_AUTHORIZATION: "awaiting_authorization",
  SUBMITTING_AUTHORIZATION: "submitting_authorization",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const PAGE_STEPS = {
  EMAIL: "email",
  PASSWORD: "password",
  EMAIL_CODE: "email_code",
  PHONE: "phone",
  SMS_CODE: "sms_code",
  PROFILE: "profile",
  AUTHORIZATION: "authorization",
  SUCCESS: "success",
  ALREADY_REGISTERED: "already_registered",
  SESSION_ENDED: "session_ended",
  CLOUDFLARE: "cloudflare",
  UNKNOWN: "unknown",
};

const VISIBLE_PASSWORD_INPUT = 'input[name="password"]:visible, input[name="new-password"]:visible, input[type="password"]:visible';
const VISIBLE_EMAIL_INPUT = 'input[name="email"]:visible, input[type="email"]:visible, input[autocomplete="username"]:visible, input[placeholder*="email" i]:visible';
const VISIBLE_EMAIL_CODE_INPUT = 'input[name="email_code"]:visible, input[name="verification_code"]:visible, input[name="code"]:visible, input[name="otp"]:visible, input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[maxlength="1"]:visible, input[maxlength="6"]:visible, input[type="tel"][maxlength]:visible, [role="textbox"][aria-label*="code" i]:visible';
const VISIBLE_PHONE_INPUT = 'input[name="phone_number"]:visible, input[name="phone"]:visible, input[type="tel"]:visible, input[autocomplete="tel"]:visible';
const VISIBLE_SMS_CODE_INPUT = 'input[name="phone_code"]:visible, input[name="sms_code"]:visible, input[name="code"]:visible, input[name="otp"]:visible, input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[maxlength="1"]:visible, input[maxlength="6"]:visible, input[type="tel"][maxlength]:visible, [role="textbox"][aria-label*="code" i]:visible';
const VISIBLE_NAME_INPUT = 'input[name="name"]:visible, input[name="full_name"]:visible, input[autocomplete="name"]:visible, input[placeholder*="name" i]:visible';
const VISIBLE_AGE_INPUT = 'input[name="age"]:visible, input[autocomplete="age"]:visible, input[id*="age"]:visible';
const SMS_DELIVERY_SELECTOR = [
  'input[type="radio"][value="sms"]:visible',
  'input[type="radio"][value="text"]:visible',
  '[role="radio"][data-value="sms"]:visible',
  '[role="radio"]:has-text("短信"):visible',
  'button:has-text("短信"):visible',
  'button:has-text("SMS"):visible',
  'button:has-text("Text message"):visible',
  'label:has-text("短信"):visible',
  'label:has-text("SMS"):visible'
].join(", ");
const AUTHORIZATION_BUTTON_SELECTOR = '[data-testid="authorize"]:visible, button:has-text("Authorize"):visible, button:has-text("Allow"):visible, button:has-text("授权"):visible, button:has-text("同意"):visible';
const FINAL_CONTINUE_SELECTOR = 'button:has-text("继续"):visible, button:has-text("Continue"):visible, input[type="submit"]:visible';

const EMAIL_CODE_TEXT = /(?:verify|confirm|check).{0,40}(?:e-?mail)|(?:e-?mail).{0,40}(?:verification|confirmation|code)|验证码.{0,12}邮箱|邮箱.{0,20}验证码/iu;
const SMS_CODE_TEXT = /(?:phone|mobile|sms|text message).{0,40}(?:verification|code)|(?:verification|code).{0,40}(?:phone|mobile|sms)|短信|手机号|手机号码/iu;
const ALREADY_REGISTERED_TEXT = /(?:already|account|email).{0,40}(?:registered|exists|taken)|(?:registered|exists|taken).{0,40}(?:already|account|email)|此邮箱.{0,20}(?:已注册|已存在)|账号.{0,20}(?:已注册|已存在)/iu;
const SESSION_ENDED_TEXT = /(?:你的|您的)?\s*会话\s*(?:已结束|已过期)|(?:your|the)?\s*session\s*(?:has ended|expired|has expired)|session ended/iu;
const AUTHORIZATION_TEXT = /(?:authorize|allow|consent|授权|同意).{0,50}(?:access|continue|应用|账号|codex|openai)?/iu;
const SUCCESS_TEXT = /(?:account|registration).{0,40}(?:created|complete|success)|注册成功|创建成功|完成注册/iu;
const WORKSPACE_TEXT = /选择一个工作空间|select (?:a|your) workspace|choose (?:a|your) workspace/iu;
const PHONE_REJECTION_PATTERNS = [
  /无法向该电话号码发送短信/iu,
  /(?:此|该)号码.{0,30}(?:已被使用|已使用|无法|不支持)/iu,
  /(?:couldn't|can't|cannot|unable).{0,100}(?:send|sms|text).{0,120}(?:whatsapp|phone|number)/iu,
  /(?:this|the) number.{0,80}(?:has been used|already used|is unavailable|is not supported)/iu,
  /(?:phone number|number).{0,80}(?:already used|has been used|unavailable|unsupported)/iu
];
const CLOUDFLARE_CHALLENGE_TEXT = /(?:__cf_chl|cloudflare|just a moment|checking your browser|verify you are human|performing security verification|challenge-platform|正在进行安全验证|安全验证.{0,24}请稍候|请稍候.{0,24}安全验证|验证您(?:是真人|是人类))/iu;

function safePageUrl(page) {
  if (!page || typeof page.url !== "function") return "";
  try {
    const url = new URL(page.url());
    // Query values may contain provider-specific challenge/session tokens;
    // retain the URL shape but never emit any query value to diagnostics.
    const queryKeys = [...url.searchParams.keys()];
    for (const key of queryKeys) url.searchParams.set(key, "[REDACTED]");
    if (url.hash) url.hash = "#[REDACTED]";
    return url.toString();
  } catch {
    return "";
  }
}

function safeLogMessage(value) {
  return String(value ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[EMAIL]")
    .replace(/\b\+?\d{7,}\b/gu, "[PHONE_OR_CODE]")
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/gu, "[REDACTED]")
    .slice(0, 300);
}

const LOGIN_TO_ANOTHER_ACCOUNT_SELECTOR = [
  'button:has-text("登录至另一个账户"):visible',
  'a:has-text("登录至另一个账户"):visible',
  'button:has-text("登录到另一个账户"):visible',
  'a:has-text("登录到另一个账户"):visible',
  'button:has-text("Log in to another account"):visible',
  'a:has-text("Log in to another account"):visible',
  'button:has-text("Login to another account"):visible',
  'a:has-text("Login to another account"):visible'
].join(", ");

const CREATE_ACCOUNT_SELECTOR = [
  // Use stable keywords instead of depending on one exact localized label.
  'button:has-text("创建"):visible',
  'a:has-text("创建"):visible',
  '[role="button"]:has-text("创建"):visible',
  'button:has-text("注册"):visible',
  'a:has-text("注册"):visible',
  '[role="button"]:has-text("注册"):visible',
  'button:has-text("Create account"):visible',
  'a:has-text("Create account"):visible',
  '[role="button"]:has-text("Create account"):visible',
  'button:has-text("Create"):visible',
  'a:has-text("Create"):visible',
  '[role="button"]:has-text("Create"):visible',
  'button:has-text("New account"):visible',
  'a:has-text("New account"):visible',
  'button:has-text("Sign up"):visible',
  'a:has-text("Sign up"):visible',
  '[role="button"]:has-text("Sign up"):visible',
  'button:has-text("Sign up for free"):visible',
  'a:has-text("Sign up for free"):visible',
  'a[href*="create-account"]:visible',
  'a[href*="signup"]:visible',
  'a[href*="sign-up"]:visible'
].join(", ");

class RegistrationSession {
  constructor(options) {
    this.id = crypto.randomUUID();
    this.email = options.email;
    this.password = options.password;
    this.name = options.name || "jdd";
    this.age = options.age || 24;
    this.onStateChange = options.onStateChange || (() => {});
    this.onLog = options.onLog || (() => {});
    this.prepareBrowserEnvironment = options.prepareBrowserEnvironment || prepareBrowserEnvironment;
    this.startOAuthImport = typeof options.startOAuthImport === "function" ? options.startOAuthImport : null;
    this.cancelOAuthImport = typeof options.cancelOAuthImport === "function" ? options.cancelOAuthImport : null;

    this.state = STATES.IDLE;
    this.mode = this.startOAuthImport ? "oauth" : "playwright";
    this.oauthOperationId = `registration-oauth:${this.id}`;
    this.cancelRequested = false;
    this.browser = null;
    this.browserMode = "headless";
    this.browserEnvironment = null;
    this.page = null;
    this.result = null;
    this.error = null;
    this.feedback = "";
    this.feedbackLevel = "info";
    this.phoneInputCount = 0;
    this.phoneOrder = null;
    this.emailCode = createEmailCodeState();
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  log(level, msg) {
    const url = safePageUrl(this.page);
    this.onLog({ level, msg, sessionId: this.id, email: this.email, url });
    try {
      console.info(`[codex-accounts-mailbox] ${level}: ${safeLogMessage(msg)}${url ? ` URL=${url}` : ""}`);
    } catch {
      // Diagnostics must never affect the registration flow.
    }
  }

  setState(state, extra = {}) {
    this.state = state;
    this.updatedAt = Date.now();
    if (Object.prototype.hasOwnProperty.call(extra, "feedback")) {
      this.feedback = typeof extra.feedback === "string" ? extra.feedback : "";
    }
    if (Object.prototype.hasOwnProperty.call(extra, "feedbackLevel")) {
      this.feedbackLevel = typeof extra.feedbackLevel === "string" ? extra.feedbackLevel : "info";
    }
    this.onStateChange({ sessionId: this.id, state, mode: this.mode, ...extra });
  }

  // 使用 Manager OAuth 或打开独立 Playwright 浏览器，推进注册会话。
  async start() {
    this.cancelRequested = false;
    this.setState(STATES.STARTING);
    this.log("info", this.mode === "oauth" ? "启动 Codex OAuth 注册/导入流程" : "启动浏览器，打开 OpenAI 注册页");

    try {
      if (this.mode === "oauth") {
        await this._startOAuthImport();
        return;
      }

      const browserEnvironment = await this.prepareBrowserEnvironment();
      this.browserEnvironment = browserEnvironment;
      const browserMode = browserEnvironment.mode;
      this.browserMode = browserMode;
      if (browserEnvironment.displayKind === "xvfb") {
        this.log("warn", `未检测到 DISPLAY，已自动启动 Xvfb ${browserEnvironment.display}；这是不可见的有头模式，若出现 Cloudflare 你也无法点击`);
      } else if (browserEnvironment.displayError) {
        this.log("warn", `Xvfb 启动失败：${browserEnvironment.displayError.message || browserEnvironment.displayError}，已退回无头模式`);
      }
      if (browserMode === "headless") {
        this.log("warn", "当前环境没有可用图形界面，使用无头浏览器；请在面板中手动填写手机号和验证码");
      }
      this.browser = await this._launchBrowser(browserMode, browserEnvironment.launchEnv);
      const context = await this.browser.newContext();
      this.page = await context.newPage();
      const page = this.page;
      if (typeof page.on === "function") {
        page.on("framenavigated", (frame) => {
          if (typeof page.mainFrame !== "function" || frame === page.mainFrame()) {
            this.log("info", "主页面导航");
          }
        });
      }

      await this.page.goto(REGISTER_URL, { waitUntil: "domcontentloaded" });
      this.log("info", "已打开 OpenAI 注册入口");

      await this._fillAccountDetails();
    } catch (error) {
      if (this.cancelRequested || this.state === STATES.CANCELLED) {
        return;
      }
      await this._fail(error);
    }
  }

  async _startOAuthImport() {
    this.setState(STATES.AWAITING_OAUTH, {
      feedback: "已切换到 Codex OAuth 流程，请在打开的浏览器中完成邮箱、密码、手机号、验证码和最终授权；面板仅提供邮箱码/接码内容显示与复制。",
      feedbackLevel: "info",
    });
    this.log("info", "已调用 Manager Codex OAuth 导入，等待浏览器完成账户流程");
    const result = await this.startOAuthImport({
      operationId: this.oauthOperationId,
      expectedEmail: this.email,
      clipboardText: this.email,
    });
    if (this.cancelRequested || this.state === STATES.CANCELLED) {
      return;
    }
    if (!result || typeof result !== "object") {
      throw new Error("Codex OAuth 导入未返回有效结果");
    }

    const importedEmail = typeof result.email === "string" && result.email ? result.email : this.email;
    this.result = {
      email: importedEmail,
      password: this.password,
      accountId: result.accountId,
      quotaRefreshed: result.quotaRefreshed,
      quotaError: result.quotaError,
    };
    const quotaMessage = result.quotaRefreshed
      ? "，额度已刷新"
      : result.quotaError
        ? `，额度刷新未完成：${result.quotaError}`
        : "";
    const message = `Codex OAuth 注册/导入已完成${quotaMessage}`;
    this.setState(STATES.COMPLETED, {
      result: this.result,
      feedback: message,
      feedbackLevel: result.quotaRefreshed === false ? "warning" : "success",
    });
    this.log(result.quotaRefreshed === false ? "warn" : "ok", message);
  }

  async _launchBrowser(browserMode, launchEnv = process.env) {
    this.browserMode = browserMode;
    if (browserMode === "headless") {
      return chromium.launch({ headless: true });
    }

    try {
      return await chromium.launch({ headless: false, env: launchEnv });
    } catch (error) {
      if (!isDisplayLaunchError(error)) throw error;
      await this.browserEnvironment?.release?.();
      this.browserEnvironment = {
        mode: "headless",
        display: "",
        displayKind: "headless",
        interactive: false,
        release: async () => {}
      };
      this.browserMode = "headless";
      this.log("warn", "可视浏览器无法连接图形界面，已切换为无头模式；请在面板中手动填写手机号和验证码");
      return chromium.launch({ headless: true });
    }
  }

  async _fillAccountDetails() {
    this.setState(STATES.AWAITING_ACCOUNT_DETAILS);
    this.log("info", `填写邮箱=${this.email}，等待检测密码或邮箱验证码输入框`);

    const accountEntry = await this._ensureNewAccountEntry();
    if (accountEntry !== PAGE_STEPS.PASSWORD) {
      await this._fillRequired(VISIBLE_EMAIL_INPUT, this.email, "邮箱输入框");
      await this._clickFirst(
        'button[type="submit"]:visible, button:has-text("Continue"):visible, input[type="submit"]:visible',
        "邮箱继续按钮"
      );
    } else {
      this.log("info", "当前页面已经是密码步骤，跳过邮箱入口检测和重复提交");
    }

    const accountDetailsStep = accountEntry === PAGE_STEPS.PASSWORD
      ? { kind: PAGE_STEPS.PASSWORD }
      : await this._waitForPageStep({ hint: PAGE_STEPS.EMAIL_CODE });
    if (accountDetailsStep.kind === PAGE_STEPS.ALREADY_REGISTERED) {
      throw new Error("该邮箱可能已经注册过，未进入密码输入步骤，请更换邮箱或直接登录");
    }
    if (accountDetailsStep.kind === PAGE_STEPS.EMAIL_CODE) {
      this.setState(STATES.AWAITING_EMAIL_CODE);
      this.log("info", "邮箱提交后直接进入邮箱验证码步骤，跳过密码输入");
      return;
    }
    if (accountDetailsStep.kind !== PAGE_STEPS.PASSWORD) {
      throw new Error("邮箱提交后未检测到密码或邮箱验证码输入框，该邮箱可能已经注册过，或注册页面结构发生变化");
    }

    this.setState(STATES.AWAITING_ACCOUNT_DETAILS);
    await this._fillRequired(VISIBLE_PASSWORD_INPUT, this.password, "密码输入框");
    await this._clickFirst(
      'button[type="submit"]:visible, button:has-text("Continue"):visible, input[type="submit"]:visible',
      "密码继续按钮"
    );

    const emailCodeStep = await this._waitForPageStep({ hint: PAGE_STEPS.EMAIL_CODE });
    if (emailCodeStep.kind === PAGE_STEPS.ALREADY_REGISTERED) {
      throw new Error("该邮箱可能已经注册过，注册流程未进入邮箱验证码步骤");
    }
    if (emailCodeStep.kind !== PAGE_STEPS.EMAIL_CODE) {
      throw new Error("密码提交后未检测到邮箱验证码输入框");
    }
    this.setState(STATES.AWAITING_EMAIL_CODE);
    this.log("info", "已进入邮箱验证码步骤，等待手动输入或从面板填入验证码");
  }

  async _ensureNewAccountEntry() {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await this._isSessionEndedPage()) {
        this._throwSessionEnded();
      }
      if (await this._hasVisible(VISIBLE_PASSWORD_INPUT)) {
        this.log("info", "检测到当前已经处于密码步骤");
        return PAGE_STEPS.PASSWORD;
      }

      if (await this._hasVisible(CREATE_ACCOUNT_SELECTOR)) {
        this.log("info", "检测到账户选择页，优先点击创建/注册入口进入注册流程");
        await this._clickFirst(CREATE_ACCOUNT_SELECTOR, "创建账户按钮");
        const formStep = await this._waitForAccountForm();
        if (formStep) return formStep;
        throw new Error("点击“创建账户”后未检测到邮箱输入框");
      }

      if (await this._hasVisible(LOGIN_TO_ANOTHER_ACCOUNT_SELECTOR)) {
        this.log("info", "未找到创建/注册入口，点击“登录至另一个账户”作为后备新账号入口");
        await this._clickFirst(LOGIN_TO_ANOTHER_ACCOUNT_SELECTOR, "登录至另一个账户按钮");
        const formStep = await this._waitForAccountForm();
        if (formStep) return formStep;
        throw new Error("点击“登录至另一个账户”后未检测到邮箱输入框");
      }

      if (await this._hasVisible(VISIBLE_EMAIL_INPUT)) return PAGE_STEPS.EMAIL;

      await this.page.waitForTimeout(250);
    }

    if (await this._isCloudflareChallenge()) {
      await this._waitForCloudflareResolution();
      return this._ensureNewAccountEntry();
    }
    throw new Error("未检测到邮箱输入框、密码输入框或新账号入口（登录至另一个账户/创建账户）");
  }

  async _fillAndSubmitProfile() {
    this.setState(STATES.AWAITING_PROFILE);
    this.log("info", `检测到姓名年龄步骤，填写姓名=${this.name} 年龄=${this.age}`);
    await this._fillRequired(VISIBLE_NAME_INPUT, this.name, "姓名输入框");
    await this._fillRequired(VISIBLE_AGE_INPUT, String(this.age), "年龄输入框");
    this.setState(STATES.SUBMITTING_PROFILE);
    await this._clickFirst(
      'button[type="submit"]:visible, button:has-text("Continue"):visible, button:has-text("Submit"):visible, input[type="submit"]:visible',
      "姓名年龄提交按钮"
    );
    await this._waitForAuthorization();
  }

  async _waitForAuthorization() {
    const authorizationStep = await this._waitForPageStep({ hint: PAGE_STEPS.AUTHORIZATION });
    if (authorizationStep.kind !== PAGE_STEPS.AUTHORIZATION) {
      throw new Error("姓名年龄提交后未检测到授权页面");
    }
    this.setState(STATES.AWAITING_AUTHORIZATION);
    this.log("info", "已进入授权步骤，等待用户点击确认授权");
  }

  async _waitForPageStep({ hint, timeoutMs = 8_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let step = await this._detectPageStep({ hint });
    if (step.kind === PAGE_STEPS.SESSION_ENDED) {
      this._throwSessionEnded();
    }
    if (step.kind === PAGE_STEPS.CLOUDFLARE) {
      await this._waitForCloudflareResolution();
      step = await this._detectPageStep({ hint });
      if (step.kind === PAGE_STEPS.SESSION_ENDED) {
        this._throwSessionEnded();
      }
    }
    while (step.kind === PAGE_STEPS.UNKNOWN && Date.now() < deadline) {
      await this.page.waitForTimeout(250);
      step = await this._detectPageStep({ hint });
      if (step.kind === PAGE_STEPS.SESSION_ENDED) {
        this._throwSessionEnded();
      }
      if (step.kind === PAGE_STEPS.CLOUDFLARE) {
        await this._waitForCloudflareResolution();
        step = await this._detectPageStep({ hint });
        if (step.kind === PAGE_STEPS.SESSION_ENDED) {
          this._throwSessionEnded();
        }
      }
    }
    return step;
  }

  async _detectPageStep({ hint } = {}) {
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    const url = typeof this.page.url === "function" ? await Promise.resolve(this.page.url()).catch(() => "") : "";
    const text = `${bodyText} ${url}`.trim();
    if (CLOUDFLARE_CHALLENGE_TEXT.test(text)) {
      return { kind: PAGE_STEPS.CLOUDFLARE };
    }
    if (SESSION_ENDED_TEXT.test(text)) {
      return { kind: PAGE_STEPS.SESSION_ENDED, reason: text.slice(0, 160) };
    }
    const hasPassword = await this._hasVisible(VISIBLE_PASSWORD_INPUT);
    if (hasPassword) {
      return { kind: PAGE_STEPS.PASSWORD };
    }

    if (ALREADY_REGISTERED_TEXT.test(text)) {
      return { kind: PAGE_STEPS.ALREADY_REGISTERED, reason: text.slice(0, 160) };
    }

    const hasAuthorizationButton = await this._hasVisible(AUTHORIZATION_BUTTON_SELECTOR);
    if (hasAuthorizationButton && (hint === PAGE_STEPS.AUTHORIZATION || AUTHORIZATION_TEXT.test(text))) {
      return { kind: PAGE_STEPS.AUTHORIZATION };
    }

    const hasFinalContinue = await this._hasVisible(FINAL_CONTINUE_SELECTOR);
    if (hasFinalContinue && WORKSPACE_TEXT.test(text)) {
      return { kind: PAGE_STEPS.AUTHORIZATION };
    }

    if (SUCCESS_TEXT.test(text) || /\/success(?:$|[/?#])/iu.test(url)) {
      return { kind: PAGE_STEPS.SUCCESS };
    }

    const hasName = await this._hasVisible(VISIBLE_NAME_INPUT);
    const hasAge = await this._hasVisible(VISIBLE_AGE_INPUT);
    if (hasName && hasAge) {
      return { kind: PAGE_STEPS.PROFILE };
    }

    const hasEmailCode = await this._hasVisible(VISIBLE_EMAIL_CODE_INPUT);
    if (hasEmailCode && (hint === PAGE_STEPS.EMAIL_CODE || EMAIL_CODE_TEXT.test(text))) {
      return { kind: PAGE_STEPS.EMAIL_CODE };
    }

    const hasSmsCode = await this._hasVisible(VISIBLE_SMS_CODE_INPUT);
    if (hasSmsCode && (hint === PAGE_STEPS.SMS_CODE || SMS_CODE_TEXT.test(text))) {
      return { kind: PAGE_STEPS.SMS_CODE };
    }

    const hasPhone = await this._hasVisible(VISIBLE_PHONE_INPUT);
    if (hasPhone && (hint === PAGE_STEPS.PHONE || SMS_CODE_TEXT.test(text))) {
      return { kind: PAGE_STEPS.PHONE };
    }

    return { kind: PAGE_STEPS.UNKNOWN };
  }

  async _hasVisible(selector) {
    const locator = this.page.locator(selector).first();
    return (await locator.count()) > 0;
  }

  async _waitForAccountForm(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._isSessionEndedPage()) {
        this._throwSessionEnded();
      }
      if (await this._hasVisible(VISIBLE_EMAIL_INPUT)) return PAGE_STEPS.EMAIL;
      if (await this._hasVisible(VISIBLE_PASSWORD_INPUT)) return PAGE_STEPS.PASSWORD;
      await this.page.waitForTimeout(250);
    }
    if (await this._isSessionEndedPage()) {
      this._throwSessionEnded();
    }
    if (await this._hasVisible(VISIBLE_EMAIL_INPUT)) return PAGE_STEPS.EMAIL;
    if (await this._hasVisible(VISIBLE_PASSWORD_INPUT)) return PAGE_STEPS.PASSWORD;
    return null;
  }

  async _isCloudflareChallenge() {
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    const url = typeof this.page.url === "function" ? await Promise.resolve(this.page.url()).catch(() => "") : "";
    return CLOUDFLARE_CHALLENGE_TEXT.test(`${bodyText} ${url}`);
  }

  async _isSessionEndedPage() {
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    const url = typeof this.page.url === "function" ? await Promise.resolve(this.page.url()).catch(() => "") : "";
    return SESSION_ENDED_TEXT.test(`${bodyText} ${url}`);
  }

  _throwSessionEnded() {
    this.log("error", REGISTRATION_SESSION_ENDED_ERROR);
    throw new Error(REGISTRATION_SESSION_ENDED_ERROR);
  }

  async _waitForCloudflareResolution(timeoutMs = 180_000) {
    const cannotInteract = this.browserMode !== "headed" || this.browserEnvironment?.interactive === false;
    if (cannotInteract) {
      const message = this.browserEnvironment?.displayKind === "xvfb"
        ? "检测到 Cloudflare 安全校验，但当前浏览器运行在 Xvfb 虚拟显示上，窗口不可见，你无法点击完成验证；请使用 X11、xpra/noVNC 或真实 DISPLAY 后重试"
        : "检测到 Cloudflare 安全校验，但当前没有可供人工点击的浏览器窗口；请使用有图形界面的浏览器环境后重试";
      this.setState(STATES.AWAITING_ACCOUNT_DETAILS, { feedback: message, feedbackLevel: "error" });
      this.log("error", message);
      throw new Error(message);
    }

    this.setState(STATES.AWAITING_ACCOUNT_DETAILS, {
      feedback: "检测到 Cloudflare 安全校验，请在浏览器窗口中人工完成；完成后助手会自动继续",
      feedbackLevel: "warning",
    });
    this.log("warn", "检测到 Cloudflare 安全校验，等待用户在可视浏览器中人工完成");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this._isCloudflareChallenge())) {
        this.setState(STATES.AWAITING_ACCOUNT_DETAILS, {
          feedback: "已完成安全校验，继续检测注册页面",
          feedbackLevel: "info",
        });
        this.log("info", "用户已完成人工安全校验，继续检测注册页面");
        return;
      }
      await this.page.waitForTimeout(500);
    }

    throw new Error("等待人工完成 Cloudflare 安全校验超时，请重新开始注册");
  }

  async _fillRequired(selector, value, label) {
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      throw new Error(`未检测到${label}`);
    }
    await locator.fill(value);
  }

  async _clickFirst(selector, label) {
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      throw new Error(`未检测到${label}`);
    }
    await locator.click();
  }

  async submitEmailVerificationCode(code) {
    if (this.state !== STATES.AWAITING_EMAIL_CODE) {
      throw new Error("当前状态不接受邮箱验证码输入");
    }
    if (!code || typeof code !== "string") {
      throw new Error("邮箱验证码不能为空");
    }

    this.setState(STATES.SUBMITTING_EMAIL_CODE, { code });
    this.log("info", "提交邮箱验证码");
    try {
      await this._fillRequired(VISIBLE_EMAIL_CODE_INPUT, code, "邮箱验证码输入框");
      await this._clickFirst(
        'button[type="submit"]:visible, button:has-text("Continue"):visible, button:has-text("Verify"):visible, input[type="submit"]:visible',
        "邮箱验证码继续按钮"
      );
      const phoneStep = await this._waitForPageStep({ hint: PAGE_STEPS.PHONE });
      if (phoneStep.kind !== PAGE_STEPS.PHONE) {
        throw new Error("邮箱验证码提交后未检测到手机号输入框");
      }
      this.setState(STATES.AWAITING_PHONE_INPUT, {
        attempt: this.phoneInputCount,
        feedback: "请输入手机号，并确认使用短信接收验证码",
        feedbackLevel: "info",
      });
      this.log("info", "已进入手机号步骤，等待手动确认手机号");
      return { accepted: true };
    } catch (error) {
      await this._fail(error);
      throw error;
    }
  }

  async acquirePhoneNumber(cardCode, { sourceId = "liye", cardKeyId = "", cardMasked = "" } = {}) {
    if (this.phoneOrder?.state?.running) {
      throw new Error("当前会话已有取号任务正在运行");
    }
    this.phoneOrder = new LIYEPhoneOrderSession({
      sourceId,
      cardKeyId,
      cardMasked,
      onStateChange: (phoneOrder) => this.onStateChange({ sessionId: this.id, phoneOrder }),
      onLog: (level, msg) => this.log(level, msg),
    });
    const phoneOrder = await this.phoneOrder.start(cardCode);
    this.onStateChange({ sessionId: this.id, phoneOrder });
    return phoneOrder;
  }

  async confirmPhoneNumber() {
    if (!this.phoneOrder) throw new Error("请先开始取号");
    const phoneOrder = await this.phoneOrder.confirmNumber();
    this.onStateChange({ sessionId: this.id, phoneOrder });
    return phoneOrder;
  }

  async replacePhoneNumber() {
    if (!this.phoneOrder) throw new Error("请先开始取号");
    const phoneOrder = await this.phoneOrder.replaceNumber();
    this.onStateChange({ sessionId: this.id, phoneOrder });
    return phoneOrder;
  }

  async cancelPhoneNumber() {
    if (!this.phoneOrder) throw new Error("当前没有取号任务");
    const phoneOrder = await this.phoneOrder.cancelNumber();
    this.onStateChange({ sessionId: this.id, phoneOrder });
    return phoneOrder;
  }

  getPhoneOrderState() {
    return this.phoneOrder?.snapshot() || null;
  }

  setEmailCodeState(emailCode) {
    if (!emailCode || typeof emailCode !== "object") {
      return;
    }
    this.emailCode = { ...this.emailCode, ...emailCode };
    this.onStateChange({ sessionId: this.id, emailCode: this.getEmailCodeState() });
  }

  getEmailCodeState() {
    return { ...this.emailCode };
  }

  // 用户在面板确认后调用；手机号可由面板自动填入，也可手动修改。
  async submitPhoneNumber(phone) {
    if (this.state !== STATES.AWAITING_PHONE_INPUT) {
      throw new Error("当前状态不接受手机号输入");
    }
    if (!phone || typeof phone !== "string") {
      throw new Error("手机号不能为空");
    }

    this.phoneInputCount += 1;
    this.setState(STATES.SUBMITTING_PHONE, {
      phone,
      attempt: this.phoneInputCount,
      feedback: "正在提交手机号并请求短信验证码",
      feedbackLevel: "info",
    });
    this.log("info", `提交手机号 ${phone}（第 ${this.phoneInputCount} 次输入）`);

    try {
      await this._fillRequired(VISIBLE_PHONE_INPUT, phone, "手机号输入框");
      const selectedSms = await this._clickIfVisible(SMS_DELIVERY_SELECTOR);
      if (selectedSms) {
        this.log("info", "已选择短信接收验证码");
      }
      await this._clickFirst(
        'button[type="submit"]:visible, button:has-text("Send code"):visible, button:has-text("Continue"):visible, input[type="submit"]:visible',
        "手机号提交按钮"
      );

      let rejected = await this._detectPhoneRejected();
      let smsStep = null;
      if (!rejected) {
        smsStep = await this._waitForPageStep({ hint: PAGE_STEPS.SMS_CODE });
        rejected = await this._detectPhoneRejected();
      }
      if (rejected) {
        this.log("warn", `号码被拒绝：${rejected}`);
        this.setState(STATES.AWAITING_PHONE_INPUT, {
          attempt: this.phoneInputCount,
          feedback: `号码未通过：${rejected}。请更换号码后重新提交。`,
          feedbackLevel: "error",
        });
        return { accepted: false, reason: rejected };
      }

      if (smsStep.kind !== PAGE_STEPS.SMS_CODE) {
        const reason = "手机号提交后未进入短信验证码接收界面，请查看浏览器提示并更换号码后重试";
        this.log("warn", reason);
        this.setState(STATES.AWAITING_PHONE_INPUT, {
          attempt: this.phoneInputCount,
          feedback: reason,
          feedbackLevel: "error",
        });
        return { accepted: false, reason };
      }
      this.setState(STATES.AWAITING_OTP_INPUT, {
        phone,
        attempt: this.phoneInputCount,
        feedback: "已进入短信验证码接收界面，请等待验证码并确认后提交。",
        feedbackLevel: "success",
      });
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

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const lines = String(bodyText || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => PHONE_REJECTION_PATTERNS.some((pattern) => pattern.test(line))) || null;
  }

  async _clickIfVisible(selector) {
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) return false;
    await locator.click();
    return true;
  }

  // 用户在面板确认后调用；短信验证码可由面板自动填入，也可手动修改。
  async submitVerificationCode(code) {
    if (this.state !== STATES.AWAITING_OTP_INPUT) {
      throw new Error("当前状态不接受验证码输入");
    }
    if (!code || typeof code !== "string") {
      throw new Error("验证码不能为空");
    }

    this.setState(STATES.SUBMITTING_OTP, {
      code,
      feedback: "正在校验短信验证码",
      feedbackLevel: "info",
    });
    this.log("info", "提交验证码");

    try {
      await this._fillRequired(VISIBLE_SMS_CODE_INPUT, code, "短信验证码输入框");
      await this._clickFirst(
        'button[type="submit"]:visible, button:has-text("Verify"):visible, button:has-text("Continue"):visible, input[type="submit"]:visible',
        "短信验证码提交按钮"
      );

      const errorText = await this._detectPhoneRejected();
      if (errorText) {
        this.log("warn", `验证码校验失败：${errorText}`);
        this.setState(STATES.AWAITING_OTP_INPUT, {
          feedback: `短信验证码校验失败：${errorText}`,
          feedbackLevel: "error",
        });
        return { accepted: false, reason: errorText };
      }

      const profileStep = await this._waitForPageStep({ hint: PAGE_STEPS.PROFILE });
      if (profileStep.kind === PAGE_STEPS.PROFILE) {
        await this._fillAndSubmitProfile();
      } else if (profileStep.kind !== PAGE_STEPS.AUTHORIZATION) {
        throw new Error("短信验证码提交后未检测到姓名年龄输入步骤");
      }

      if (this.state !== STATES.AWAITING_AUTHORIZATION) {
        await this._waitForAuthorization();
      }
      return { accepted: true };
    } catch (error) {
      await this._fail(error);
      throw error;
    }
  }

  async authorize() {
    if (this.state !== STATES.AWAITING_AUTHORIZATION) {
      throw new Error("当前状态不接受授权确认");
    }
    this.setState(STATES.SUBMITTING_AUTHORIZATION);
    this.log("info", "用户确认授权，提交授权页面");
    try {
      await this._clickFirst(
        `${AUTHORIZATION_BUTTON_SELECTOR}, ${FINAL_CONTINUE_SELECTOR}`,
        "授权/继续按钮"
      );
      await this.page.waitForTimeout(1500);
      const nextStep = await this._detectPageStep({ hint: PAGE_STEPS.SUCCESS });
      if (![PAGE_STEPS.SUCCESS, PAGE_STEPS.UNKNOWN, PAGE_STEPS.AUTHORIZATION].includes(nextStep.kind)) {
        throw new Error("授权后页面未进入完成状态");
      }
      this.result = { email: this.email, password: this.password };
      const oauthPending = nextStep.kind !== PAGE_STEPS.SUCCESS;
      const completionMessage = oauthPending
        ? "注册信息、邮箱验证、手机号验证和姓名年龄均已完成；最后的 Codex OAuth/工作区验证可能仍在进行，已按注册成功记录。"
        : "注册和授权流程完成";
      this.setState(STATES.COMPLETED, {
        result: this.result,
        feedback: completionMessage,
        feedbackLevel: oauthPending ? "warning" : "success",
      });
      this.log(oauthPending ? "warn" : "ok", completionMessage);
      await this._closeBrowser();
      return {
        accepted: true,
        result: this.result,
        oauthPending,
        message: completionMessage,
      };
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
    this.setState(STATES.AWAITING_PHONE_INPUT, {
      attempt: this.phoneInputCount,
      feedback: "请输入新的手机号并重新提交",
      feedbackLevel: "info",
    });
  }

  async cancel() {
    this.cancelRequested = true;
    this.log("info", "使用者取消注册流程");
    if (this.mode === "oauth" && this.cancelOAuthImport) {
      try {
        this.cancelOAuthImport(this.oauthOperationId);
      } catch {
        // OAuth cancellation is best-effort; the session still moves to cancelled.
      }
    }
    if (this.phoneOrder?.state?.running) {
      await this.phoneOrder.cancelNumber().catch(() => this.phoneOrder.dispose());
    }
    await this._closeBrowser();
    this.setState(STATES.CANCELLED, {
      feedback: this.mode === "oauth" ? "Codex OAuth 流程已取消" : "注册流程已取消",
      feedbackLevel: "info",
    });
  }

  async _fail(error) {
    await this._closeBrowser();
    this.error = error;
    this.setState(STATES.FAILED, { error: error.message, feedback: error.message, feedbackLevel: "error" });
    this.log("error", `流程失败：${error.message}`);
  }

  async _closeBrowser() {
    const browser = this.browser;
    const browserEnvironment = this.browserEnvironment;
    this.browser = null;
    this.page = null;
    this.browserEnvironment = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    try {
      await Promise.resolve(browserEnvironment?.release?.());
    } catch {
      // Virtual display cleanup must not mask the registration result.
    }
  }
}

module.exports = { RegistrationSession, STATES };
