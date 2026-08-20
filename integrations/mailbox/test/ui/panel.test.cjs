"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createMailboxPanelHtml, createRegistrationPanelHtml } = require("../../src/ui/panel.cjs");

test("standalone registration panel provides mailbox-library selection and direct email entry", () => {
  const html = createRegistrationPanelHtml();
  assert.match(html, /<title>注册助手<\/title>/u);
  assert.match(html, /const registrationOnly = true;/u);
  assert.match(html, /registrationMailboxSearch/u);
  assert.match(html, /registrationMailboxProviderFilter/u);
  assert.match(html, /registrationMailboxSort/u);
  assert.match(html, /data-action="registration-select-mailbox"/u);
  assert.match(html, /data-action="registration-cleanup-all"/u);
  assert.match(html, /清除所有记录/u);
  assert.match(html, /邮箱库为空，请直接输入新邮箱/u);
  assert.match(html, /已自动隐藏/u);
  assert.match(html, /hasManagedCodexEmail/u);
  assert.match(html, /选择邮箱只会填入地址，不会自动开始注册/u);
  assert.match(html, /不会自动填写或提交/u);
});

test("new registration sessions are rendered above older sessions", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  let renderedHtml = "";
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = { addEventListener(type, listener) { windowListeners.set(type, listener); } };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [],
      providers: [],
      registrationSessions: [
        { id: "session:old", email: "old@example.com", mode: "oauth", state: "awaiting_oauth", phoneOrder: { phase: "idle", running: false }, emailCode: { phase: "idle" } },
        { id: "session:new", email: "new@example.com", mode: "oauth", state: "awaiting_oauth", phoneOrder: { phase: "idle", running: false }, emailCode: { phase: "idle" } }
      ]
    }
  } });

  assert.ok(renderedHtml.indexOf("new@example.com") < renderedHtml.indexOf("old@example.com"));
});

test("registration mailbox library hides emails already imported into Codex", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  let renderedHtml = "";
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = { addEventListener(type, listener) { windowListeners.set(type, listener); } };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:linked", providerId: "mock", address: "linked@example.com", displayName: "linked@example.com" },
        { id: "mailbox:free", providerId: "mock", address: "free@example.com", displayName: "free@example.com" }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      managedAccountEmailsAvailable: true,
      managedAccountEmails: ["LINKED@example.com"],
      registrationSessions: []
    }
  } });

  assert.doesNotMatch(renderedHtml, /linked@example\.com/iu);
  assert.match(renderedHtml, /free@example\.com/u);
  assert.match(renderedHtml, /已自动隐藏 1 个/u);
});

test("standalone registration panel preserves scroll position when state updates", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  let renderedHtml = "";
  let registrationStandalone;
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) {
      renderedHtml = value;
      registrationStandalone = { scrollTop: 0 };
    }
  });
  const notice = {};
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) {
      return id === "app" ? app : id === "notice" ? notice : null;
    },
    querySelector(selector) {
      return selector === ".registration-standalone" ? registrationStandalone : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };
  const context = {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  };

  vm.runInNewContext(script, context);
  const stateListener = windowListeners.get("message");
  assert.ok(stateListener);
  stateListener({ data: { type: "state", state: { mailboxes: [], providers: [], registrationSessions: [] } } });
  registrationStandalone.scrollTop = 487;
  stateListener({ data: { type: "state", state: { mailboxes: [], providers: [], registrationSessions: [] } } });

  assert.equal(registrationStandalone.scrollTop, 487);
  assert.equal(messages.at(-1).action, "ready");
});

test("registration session does not render identical error and feedback twice", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  let renderedHtml = "";
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) {
      return id === "app" ? app : id === "notice" ? {} : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });
  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [],
      providers: [],
      registrationSessions: [{
        id: "session:test",
        email: "test@example.com",
        state: "failed",
        error: "DUPLICATE-ERROR",
        feedback: "DUPLICATE-ERROR",
        feedbackLevel: "error"
      }]
    }
  } });

  assert.equal((renderedHtml.match(/DUPLICATE-ERROR/gu) || []).length, 1);
});

test("OAuth registration sessions point to the external browser and keep panel data copy-only", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  let renderedHtml = "";
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) {
      return id === "app" ? app : id === "notice" ? {} : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });
  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [],
      providers: [],
      registrationSessions: [{
        id: "session:oauth",
        email: "oauth@example.com",
        mode: "oauth",
        state: "awaiting_oauth",
        phoneInputCount: 0,
        phoneOrder: { phase: "idle", running: false },
        emailCode: { phase: "received", code: "123456", receivedAt: "2026-08-20T10:00:00.000Z" }
      }]
    }
  } });

  assert.match(renderedHtml, /Codex OAuth/u);
  assert.match(renderedHtml, /registration-acquire-phone/u);
  assert.match(renderedHtml, /registration-copy-email-code/u);
  assert.match(renderedHtml, /取消 OAuth 流程/u);
  assert.doesNotMatch(renderedHtml, /registration-submit-email-code/u);
});

test("registration cards delete their mailbox directly and the header clears all registration records", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const window = { addEventListener(type, listener) { windowListeners.set(type, listener); } };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [{ id: "mailbox:registration", address: "registered@example.com", displayName: "registered@example.com", providerId: "mock" }],
      providers: [],
      registrationSessions: [{
        id: "session:registration",
        email: "REGISTERED@example.com",
        mode: "oauth",
        state: "awaiting_oauth",
        phoneOrder: { phase: "idle", running: false },
        emailCode: { phase: "idle" }
      }]
    }
  } });

  assert.match(renderedHtml, /data-action="registration-delete-mailbox"/u);
  assert.match(renderedHtml, /data-mailbox-id="mailbox:registration"/u);
  const click = documentListeners.get("click");
  click({ target: {
    disabled: false,
    dataset: { action: "registration-delete-mailbox", mailboxId: "mailbox:registration" },
    closest() { return this; }
  } });
  click({ target: {
    disabled: false,
    dataset: { action: "registration-cleanup-all" },
    closest() { return this; }
  } });

  assert.deepEqual(messages.filter((message) => message.action !== "ready").map((message) => ({ action: message.action, mailboxId: message.mailboxId })), [
    { action: "registrationDeleteMailbox", mailboxId: "mailbox:registration" },
    { action: "registrationCleanupAll", mailboxId: undefined }
  ]);
});

test("Mailbox panel fills the webview and keeps one scrollable detail content area", () => {
  const html = createMailboxPanelHtml();
  assert.match(html, /body \{ margin: 0; padding: 0; min-height: 100vh; overflow: hidden;/u);
  assert.match(html, /\.layout \{ flex: 1 1 auto;/u);
  assert.match(html, /\.content \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/u);
  assert.doesNotMatch(html, /height: min\(700px, calc\(100vh - 120px\)\)/u);
  assert.match(html, /message\.type === "operation-complete"/u);
  assert.match(html, /function requestCodexImport\(/u);
  assert.match(html, /codexImportCancellable/u);
  assert.match(html, /button:active:not\(:disabled\)/u);
  assert.match(html, /type="button" class="primary" data-action="open-import"/u);
  assert.match(html, /function closestTarget\(/u);
  assert.match(html, /邮箱来源正在加载/u);
  assert.match(html, /function clearPressedButtons\(/u);
  assert.match(html, /registration-phone-order/u);
  assert.match(html, /registration-credential-grid/u);
  assert.match(html, /function renderRegistrationInputs\(/u);
  assert.match(html, /id="phoneInput-/u);
  assert.match(html, /id="otpInput-/u);
  assert.match(html, /registrationInputValues/u);
  assert.match(html, /registration-acquire-phone/u);
  assert.match(html, /registration-copy-phone/u);
  assert.match(html, /registration-copy-code/u);
  assert.match(html, /registration-copy-email-code/u);
  assert.match(html, /registration-refresh-email-code/u);
  assert.match(html, /action === "registration-copy-email-code"/u);
  assert.match(html, /renderRegistrationEmailCode/u);
  assert.match(html, /最近 30 分钟/u);
  assert.match(html, /不会自动填写或提交/u);
  assert.match(html, /registration-replace-phone/u);
  assert.match(html, /registration-cancel-phone/u);
  assert.match(html, /registrationPhoneSource-/u);
  assert.match(html, /registrationPhoneKey-/u);
  assert.match(html, /<details class="registration-key-pool">/u);
  assert.match(html, /updateRegistrationAcquireButton\(sessionId\)/u);
  assert.match(html, /registration-add-phone-key/u);
  assert.match(html, /registration-remove-phone-key/u);
  assert.match(html, /data-registration-countdown/u);
  assert.match(html, /\}, 1000\);/u);
  assert.match(html, /自动读取短信/u);
  assert.match(html, /成功率/u);
  assert.match(html, /.notice.success/u);
  assert.doesNotMatch(html, /确认号码，读取验证码/u);
  assert.match(html, /不会自动填写或提交/u);
  assert.match(html, /registration-progress/u);
  assert.match(html, /registration-fill-email-code/u);
  assert.match(html, /registration-fill-phone/u);
  assert.match(html, /registration-fill-code/u);
  assert.match(html, /registration-authorize/u);
  assert.match(html, /确认授权并完成/u);
  assert.match(html, /最后继续/u);
  assert.match(html, /session\.feedback/u);
  assert.match(html, /只把识别内容/u);
  assert.doesNotMatch(html, /window\.confirm\(/u);
  assert.match(html, /function renderDeleteConfirmModal\(/u);
  assert.match(html, /data-action="cancel-delete"/u);
  assert.match(html, /data-action="confirm-delete"/u);
  const selectedRenderer = html.slice(html.indexOf("function renderSelected(selected)"), html.indexOf("function renderMessageRow(message)"));
  assert.match(selectedRenderer, /const mailboxError = mailbox\.lastError/u);
  assert.doesNotMatch(html, /仅未出码/u);
  assert.match(html, /仅未接入 Codex/u);
  assert.match(html, /mailboxProviderFilter/u);
  assert.match(html, /function filterMailboxes\(/u);
  assert.match(html, /onlyUnlinkedCodex/u);
  assert.match(html, /按邮箱来源筛选/u);
  assert.match(html, /全选当前结果/u);
  assert.match(html, /批量查询/u);
  assert.match(html, /批量监听/u);
  assert.match(html, /批量停止/u);
  assert.match(html, /批量删除/u);
});

test("selecting an available registration key enables phone ordering", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  const acquireButton = { dataset: { sessionId: "session:key-select" }, disabled: true };
  const app = { innerHTML: "" };
  const notice = { textContent: "", className: "" };
  const document = {
    activeElement: null,
    getElementById(id) {
      return id === "app" ? app : id === "notice" ? notice : null;
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '[data-action="registration-acquire-phone"]' ? [acquireButton] : [];
    },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };

  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [],
      providers: [],
      phoneSources: [{ id: "liye", displayName: "LIYE", websiteUrl: "https://liye.5x20.cn" }],
      registrationKeyPool: {
        count: 1,
        available: 1,
        inUse: 0,
        keys: [{ id: "key-1", masked: "KEY…-1", status: "available" }]
      },
      registrationSessions: [{
        id: "session:key-select",
        email: "key@example.com",
        state: "awaiting_phone_input",
        mode: "oauth",
        phoneOrder: { phase: "idle", running: false }
      }]
    }
  } });

  const selected = {
    id: "registrationPhoneKey-session:key-select",
    value: "key-1",
    closest() { return this; },
    matches() { return false; }
  };
  documentListeners.get("change")({ target: selected });
  assert.equal(acquireButton.disabled, false);
});

test("Mailbox delete uses an in-panel confirmation before posting the delete action", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let insertedModal = "";
  const app = { insertAdjacentHTML() {} };
  const notice = {};
  const document = {
    activeElement: null,
    body: {
      insertAdjacentHTML(_position, value) { insertedModal = value; }
    },
    getElementById(id) {
      return id === "app" ? app : id === "notice" ? notice : null;
    },
    querySelector(selector) {
      if (selector === ".modal-backdrop" && insertedModal) return { remove() { insertedModal = ""; } };
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };
  const context = {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  };

  vm.runInNewContext(script, context);
  windowListeners.get("message")({
    data: {
      type: "state",
      state: {
        mailboxes: [{ id: "mailbox:test", providerId: "mock", address: "test@example.com", displayName: "test@example.com", messageCount: 0, historyMode: "latest" }],
        selectedMailboxId: "mailbox:test",
        operations: [],
        codexImports: [],
        codexImportCancellable: false,
        providers: [{ id: "mock", displayName: "Mock", capabilities: { history: "latest", maxMessages: 1, manualRenewal: false }, importSchema: {} }],
        codexImportAvailable: false,
        managedAccountEmails: []
      }
    }
  });

  const click = documentListeners.get("click");
  click({ target: { disabled: false, dataset: { action: "delete-mailbox", mailboxId: "mailbox:test" }, closest() { return this; } } });
  assert.match(insertedModal, /data-action="cancel-delete"/u);
  assert.match(insertedModal, /data-action="confirm-delete"/u);
  assert.equal(messages.filter((message) => message.action === "delete").length, 0);

  click({ target: { disabled: false, dataset: { action: "cancel-delete" }, closest() { return this; } } });
  assert.equal(messages.filter((message) => message.action === "delete").length, 0);

  click({ target: { disabled: false, dataset: { action: "delete-mailbox", mailboxId: "mailbox:test" }, closest() { return this; } } });
  click({ target: { disabled: false, dataset: { action: "confirm-delete" }, closest() { return this; } } });
  const deleteMessage = messages.filter((message) => message.action === "delete").at(-1);
  assert.equal(deleteMessage.type, "mailbox:action");
  assert.equal(deleteMessage.action, "delete");
  assert.equal(deleteMessage.mailboxId, "mailbox:test");
});
