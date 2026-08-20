"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareBrowserEnvironment, resolveBrowserMode } = require("../../src/operations/browser-mode.cjs");
const { RegistrationSession, STATES } = require("../../src/operations/registration-flow.cjs");

function createTestSession(options) {
  return new RegistrationSession({
    ...options,
    prepareBrowserEnvironment: async () => ({
      mode: "headless",
      launchEnv: {},
      display: "",
      displayKind: "headless",
      interactive: false,
      release: async () => {}
    })
  });
}

test("registration browser defaults to headless when no display is available", () => {
  assert.equal(resolveBrowserMode({}), "headless");
  assert.equal(resolveBrowserMode({ DISPLAY: "" }), "headless");
});

test("registration browser uses headed mode when DISPLAY is available", () => {
  assert.equal(resolveBrowserMode({ DISPLAY: ":1" }), "headed");
});

test("registration browser mode can be explicitly overridden", () => {
  assert.equal(resolveBrowserMode({ DISPLAY: ":1", CODEX_MAILBOX_HEADLESS: "true" }), "headless");
  assert.equal(resolveBrowserMode({ CODEX_MAILBOX_HEADLESS: "false" }), "headed");
});

test("registration start prepares an invisible headed Xvfb environment when DISPLAY is absent", async () => {
  let released = false;
  const environment = await prepareBrowserEnvironment(
    { CODEX_MAILBOX_HEADLESS: "false" },
    {
      ensureDisplay: async () => ({
        display: ":99",
        kind: "xvfb",
        interactive: false,
        release: async () => { released = true; }
      })
    }
  );

  assert.equal(environment.mode, "headed");
  assert.equal(environment.launchEnv.DISPLAY, ":99");
  assert.equal(environment.displayKind, "xvfb");
  assert.equal(environment.interactive, false);
  await environment.release();
  assert.equal(released, true);
});

test("registration diagnostics recognize a Cloudflare challenge page", async () => {
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session.page = {
    locator() {
      return { async innerText() { return "Just a moment... Checking your browser"; } };
    },
    url() {
      return "https://auth.openai.com/create-account?__cf_chl_rt_tk=challenge-secret";
    }
  };

  assert.equal(await session._isCloudflareChallenge(), true);
});

test("registration diagnostics recognize the Chinese Cloudflare challenge page", async () => {
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session.page = {
    locator() {
      return { async innerText() { return "正在进行安全验证\\n请稍候"; } };
    },
    url() {
      return "https://chatgpt.com/auth/login";
    }
  };

  assert.equal(await session._isCloudflareChallenge(), true);
});

test("headed registration waits for manual Cloudflare resolution", async () => {
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  let challenge = true;
  session.browserMode = "headed";
  session.page = {
    locator() {
      return { async innerText() { return ""; } };
    },
    url() {
      return "https://auth.openai.com/create-account";
    },
    async waitForTimeout() {
      challenge = false;
    }
  };
  session._isCloudflareChallenge = async () => challenge;

  await session._waitForCloudflareResolution(1_000);
  assert.equal(session.feedback, "已完成安全校验，继续检测注册页面");
});

test("Xvfb Cloudflare detection reports that the invisible window cannot be clicked", async () => {
  const logs = [];
  const session = createTestSession({
    email: "new@example.com",
    password: "secret-password",
    onLog: (entry) => logs.push(entry)
  });
  session.browserMode = "headed";
  session.browserEnvironment = {
    display: ":99",
    displayKind: "xvfb",
    interactive: false
  };
  session.page = {
    locator() {
      return { async innerText() { return "Just a moment... Checking your browser"; } };
    },
    url() {
      return "https://auth.openai.com/create-account";
    }
  };

  await assert.rejects(session._waitForCloudflareResolution(), /你无法点击/u);
  assert.equal(session.feedbackLevel, "error");
  assert.match(logs.at(-1)?.msg || "", /Xvfb|无法点击/u);
});

test("registration diagnostics expose the current page URL without query secrets", () => {
  const logs = [];
  const session = createTestSession({
    email: "new@example.com",
    password: "secret-password",
    onLog: (entry) => logs.push(entry)
  });
  session.page = { url: () => "https://auth.openai.com/create-account/password?state=state-secret&next=%2Fcontinue#access-token-secret" };

  session.log("info", "页面导航");

  assert.match(logs[0].url, /^https:\/\/auth\.openai\.com\/create-account\/password\?state=%5BREDACTED%5D&next=%5BREDACTED%5D#\[REDACTED\]$/u);
  assert.doesNotMatch(logs[0].url, /state-secret|access-token-secret/u);
});

test("registration flow detects each page, pauses for codes, fills profile, and waits for explicit authorization", async () => {
  const page = new FakeRegistrationPage();
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() { page.closed = true; } };
  const session = createTestSession({
    email: "new@example.com",
    password: "secret-password",
    name: "jdd",
    age: 24
  });
  session._launchBrowser = async () => browser;

  await session.start();
  assert.equal(session.state, STATES.AWAITING_EMAIL_CODE);
  assert.equal(page.values.email, "new@example.com");
  assert.equal(page.values.password, "secret-password");
  assert.equal(page.values.name, undefined);
  assert.equal(page.values.age, undefined);

  await session.submitEmailVerificationCode("email-123");
  assert.equal(session.state, STATES.AWAITING_PHONE_INPUT);
  await session.submitPhoneNumber("+8613800000000");
  assert.equal(session.state, STATES.AWAITING_OTP_INPUT);
  await session.submitVerificationCode("sms-456");
  assert.equal(session.state, STATES.AWAITING_AUTHORIZATION);
  assert.equal(page.values.name, "jdd");
  assert.equal(page.values.age, "24");
  assert.equal(page.values.emailCode, "email-123");
  assert.equal(page.values.phone, "+8613800000000");
  assert.equal(page.values.smsCode, "sms-456");
  assert.equal(page.clickedAuthorization, false);

  await session.authorize();
  assert.equal(session.state, STATES.COMPLETED);
  assert.equal(page.clickedAuthorization, true);
  assert.equal(page.closed, true);
});

test("registration flow prioritizes the create-account entry before filling a new email", async () => {
  const page = new FakeRegistrationPage({ accountChooser: true });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();

  assert.equal(page.entryChoice, "create-account");
  assert.equal(page.values.email, "new@example.com");
  assert.equal(session.state, STATES.AWAITING_EMAIL_CODE);
});

test("registration flow falls back to login to another account when no create entry exists", async () => {
  const page = new FakeRegistrationPage({ accountChooser: true, loginOnly: true });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();

  assert.equal(page.entryChoice, "login-to-another-account");
  assert.equal(page.values.email, "new@example.com");
  assert.equal(session.state, STATES.AWAITING_EMAIL_CODE);
});

test("registration flow continues when the browser opens directly on the password step", async () => {
  const page = new FakeRegistrationPage({ passwordOnOpen: true });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();

  assert.equal(page.values.email, undefined);
  assert.equal(page.values.password, "secret-password");
  assert.equal(session.state, STATES.AWAITING_EMAIL_CODE);
});

test("registration flow accepts an email verification step directly after email submission", async () => {
  const page = new FakeRegistrationPage({ emailCodeOnEmailSubmit: true });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();

  assert.equal(session.state, STATES.AWAITING_EMAIL_CODE);
  assert.equal(page.values.email, "new@example.com");
  assert.equal(page.values.password, undefined);

  await session.submitEmailVerificationCode("email-123");
  assert.equal(session.state, STATES.AWAITING_PHONE_INPUT);
  assert.equal(page.values.emailCode, "email-123");
});

test("registration flow delegates to the Manager Codex OAuth import when available", async () => {
  let oauthOptions;
  const session = createTestSession({
    email: "new@example.com",
    password: "secret-password",
    startOAuthImport: async (options) => {
      oauthOptions = options;
      return {
        accountId: "account-1",
        email: "new@example.com",
        quotaRefreshed: true
      };
    }
  });

  await session.start();

  assert.equal(session.mode, "oauth");
  assert.equal(session.state, STATES.COMPLETED);
  assert.equal(oauthOptions.expectedEmail, "new@example.com");
  assert.equal(oauthOptions.clipboardText, "new@example.com");
  assert.match(oauthOptions.operationId, /^registration-oauth:/u);
  assert.equal(session.result.accountId, "account-1");
});

test("registration flow cancels an in-flight Manager Codex OAuth import", async () => {
  let rejectOAuth;
  let cancelledOperationId;
  const session = createTestSession({
    email: "new@example.com",
    password: "secret-password",
    startOAuthImport: () => new Promise((resolve, reject) => {
      rejectOAuth = reject;
    }),
    cancelOAuthImport: (operationId) => {
      cancelledOperationId = operationId;
      rejectOAuth(new Error("OAuth login cancelled by user."));
    }
  });

  const started = session.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.state, STATES.AWAITING_OAUTH);

  await session.cancel();
  await started;

  assert.equal(session.state, STATES.CANCELLED);
  assert.equal(cancelledOperationId, session.oauthOperationId);
});

test("registration flow selects SMS and keeps phone rejection feedback until a usable number reaches the code screen", async () => {
  const rejectedMessage = "我们无法向该电话号码发送短信，因此已切换为 WhatsApp。请继续通过 WhatsApp 发送验证码。";
  const page = new FakeRegistrationPage({ phoneError: rejectedMessage });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();
  await session.submitEmailVerificationCode("email-123");

  const rejected = await session.submitPhoneNumber("+8613800000000");
  assert.equal(rejected.accepted, false);
  assert.equal(session.state, STATES.AWAITING_PHONE_INPUT);
  assert.match(session.feedback, /无法向该电话号码发送短信/u);
  assert.equal(page.selectedDelivery, "sms");

  page.phoneError = "此号码已被使用";
  const rejectedAgain = await session.submitPhoneNumber("+8613900000000");
  assert.equal(rejectedAgain.accepted, false);
  assert.match(session.feedback, /此号码已被使用/u);
  assert.equal(session.state, STATES.AWAITING_PHONE_INPUT);

  page.phoneError = "";
  const accepted = await session.submitPhoneNumber("+8613700000000");
  assert.equal(accepted.accepted, true);
  assert.equal(session.state, STATES.AWAITING_OTP_INPUT);
});

test("registration flow treats the final workspace Continue as completion after profile submission", async () => {
  const page = new FakeRegistrationPage({ workspace: true });
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() { page.closed = true; } };
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => browser;

  await session.start();
  await session.submitEmailVerificationCode("email-123");
  await session.submitPhoneNumber("+8613800000000");
  await session.submitVerificationCode("sms-456");

  assert.equal(session.state, STATES.AWAITING_AUTHORIZATION);
  assert.equal(page.stage, "workspace");
  await session.authorize();

  assert.equal(session.state, STATES.COMPLETED);
  assert.equal(page.finalContinueClicked, true);
  assert.equal(page.closed, true);
});

test("registration flow stops with a registered-account message when the password step never appears", async () => {
  const page = new FakeRegistrationPage({ existingAccount: true });
  const session = createTestSession({ email: "existing@example.com", password: "secret-password" });
  session._launchBrowser = async () => ({ async newContext() { return { async newPage() { return page; } }; }, async close() {} });

  await session.start();
  assert.equal(session.state, STATES.FAILED);
  assert.match(session.error?.message || "", /已经注册过/u);
});

test("registration flow reports an expired OpenAI entry session separately", async () => {
  const page = new FakeRegistrationPage({ sessionEnded: true });
  const session = createTestSession({ email: "new@example.com", password: "secret-password" });
  session._launchBrowser = async () => ({ async newContext() { return { async newPage() { return page; } }; }, async close() {} });

  await session.start();

  assert.equal(session.state, STATES.FAILED);
  assert.match(session.error?.message || "", /会话已结束/u);
});

class FakeRegistrationPage {
  constructor({ existingAccount = false, accountChooser = false, loginOnly = false, passwordOnOpen = false, emailCodeOnEmailSubmit = false, phoneError = "", workspace = false, sessionEnded = false } = {}) {
    this.stage = sessionEnded ? "session-ended" : accountChooser ? "account-chooser" : passwordOnOpen ? "password" : "email";
    this.existingAccount = existingAccount;
    this.loginOnly = loginOnly;
    this.emailCodeOnEmailSubmit = emailCodeOnEmailSubmit;
    this.phoneError = phoneError;
    this.workspace = workspace;
    this.values = {};
    this.closed = false;
    this.clickedAuthorization = false;
    this.finalContinueClicked = false;
    this.selectedDelivery = null;
    this.entryChoice = null;
  }

  async goto() {}

  async waitForTimeout() {}

  url() {
    return `https://auth.openai.com/create-account/${this.stage}`;
  }

  locator(selector) {
    const page = this;
    const locator = {
      first() { return this; },
      async count() { return page.count(selector); },
      async fill(value) { page.fill(selector, value); },
      async click() { page.click(selector); },
      async innerText() { return page.bodyText(); },
      async textContent() { return page.bodyText(); }
    };
    return locator;
  }

  count(selector) {
    if (selector === "body") return 1;
    if (/登录至另一个账户|登录到另一个账户|Log in to another account|Login to another account/u.test(selector)) {
      return this.stage === "account-chooser" ? 1 : 0;
    }
    if (/创建|Create|New account|Sign up|注册|signup/u.test(selector)) {
      return this.stage === "account-chooser" && !this.loginOnly ? 1 : 0;
    }
    if (/password/u.test(selector)) return this.stage === "password" ? 1 : 0;
    if (/email_code|verification_code|name="code"|name="otp"|one-time-code/u.test(selector)) {
      return ["email-code", "sms"].includes(this.stage) ? 1 : 0;
    }
    if (/phone_number|type="tel"/u.test(selector)) return this.stage === "phone" ? 1 : 0;
    if (/phone_code|sms_code|maxlength/u.test(selector)) return this.stage === "sms" ? 1 : 0;
    if (/full_name|name="name"/u.test(selector)) return this.stage === "profile" ? 1 : 0;
    if (/name="age"|autocomplete="age"|id\*="age"/u.test(selector)) return this.stage === "profile" ? 1 : 0;
    if (/data-testid="authorize"|Authorize|Allow|授权|同意/u.test(selector)) {
      return this.stage === "authorization" || (this.stage === "workspace" && /继续|Continue/u.test(selector)) ? 1 : 0;
    }
    if (/value="sms"|value="text"|role="radio"|短信|SMS|Text message/u.test(selector)) return this.stage === "phone" ? 1 : 0;
    if (/button|type="submit"|type="submit"/u.test(selector)) return ["email", "password", "email-code", "phone", "sms", "profile", "workspace"].includes(this.stage) ? 1 : 0;
    if (/type="email"/u.test(selector)) return this.stage === "email" ? 1 : 0;
    return 0;
  }

  fill(selector, value) {
    if (/email_code|verification_code|name="code"|name="otp"|one-time-code/u.test(selector)) {
      this.values[this.stage === "email-code" ? "emailCode" : "smsCode"] = value;
    } else if (/email/u.test(selector)) this.values.email = value;
    else if (/password/u.test(selector)) this.values.password = value;
    else if (/phone_number|type="tel"/u.test(selector)) this.values.phone = value;
    else if (/phone_code|sms_code|maxlength/u.test(selector)) this.values.smsCode = value;
    else if (/full_name|name="name"/u.test(selector)) this.values.name = value;
    else if (/name="age"|autocomplete="age"|id\*="age"/u.test(selector)) this.values.age = value;
  }

  click(selector) {
    if (/登录至另一个账户|登录到另一个账户|Log in to another account|Login to another account/u.test(selector)) {
      this.entryChoice = "login-to-another-account";
      this.stage = "email";
      return;
    }
    if (/创建|Create|New account|Sign up|注册|signup/u.test(selector)) {
      this.entryChoice = "create-account";
      this.stage = "email";
      return;
    }
    if (this.stage === "phone" && /value="sms"|value="text"|role="radio"|短信|SMS|Text message/u.test(selector)) {
      this.selectedDelivery = "sms";
      return;
    }
    if (/Authorize|Allow|授权|同意|data-testid="authorize"/u.test(selector)) {
      if (this.stage === "workspace" && /继续|Continue/u.test(selector)) {
        this.finalContinueClicked = true;
        this.stage = "success";
        return;
      }
      this.clickedAuthorization = true;
      this.stage = "success";
      return;
    }
    if (!/button|submit/u.test(selector)) return;
    if (this.stage === "email") this.stage = this.existingAccount ? "existing" : this.emailCodeOnEmailSubmit ? "email-code" : "password";
    else if (this.stage === "password") this.stage = "email-code";
    else if (this.stage === "email-code") this.stage = "phone";
    else if (this.stage === "phone") this.stage = this.phoneError ? "phone" : "sms";
    else if (this.stage === "sms") this.stage = "profile";
    else if (this.stage === "profile") this.stage = this.workspace ? "workspace" : "authorization";
    else if (this.stage === "workspace") this.stage = "success";
  }

  bodyText() {
    switch (this.stage) {
      case "session-ended": return "你的会话已结束 登录以继续，或在不登录的情况下使用 ChatGPT.com";
      case "account-chooser": return "Welcome back Select an account Log in to another account Create account";
      case "email-code": return "Verify your email with the code we sent";
      case "phone": return this.phoneError ? `Enter your phone number\n${this.phoneError}` : "Enter your phone number";
      case "sms": return "Enter the SMS verification code";
      case "profile": return "Tell us your name and age";
      case "authorization": return "Authorize access to continue";
      case "workspace": return "选择一个工作空间\n继续";
      case "success": return "Account created successfully";
      case "existing": return "This email is already registered";
      default: return "";
    }
  }
}
