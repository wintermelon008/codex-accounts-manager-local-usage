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
  assert.match(html, /registrationOnlyUnregisteredGpt/u);
  assert.match(html, /仅显示未注册 GPT/u);
  assert.match(html, /data-action="registration-select-mailbox"/u);
  assert.match(html, /data-action="registration-cleanup-all"/u);
  assert.match(html, /清除所有记录/u);
  assert.match(html, /邮箱库为空，请直接输入新邮箱/u);
  assert.match(html, /已自动隐藏/u);
  assert.match(html, /注册并导入 Codex/u);
  assert.match(html, /注册 GPT/u);
  assert.match(html, /data-import-codex="true"/u);
  assert.match(html, /data-import-codex="false"/u);
  assert.match(html, /完成 GPT 注册/u);
  assert.match(html, /导入 Codex/u);
  assert.match(html, /registrationCompleteManual/u);
  assert.match(html, /registrationCodexImport/u);
  assert.match(html, /registrationStopEmailCode/u);
  assert.match(html, /manual-browser/u);
  assert.match(html, /hasManagedCodexEmail/u);
  assert.match(html, /选择邮箱只会填入地址，不会自动开始注册/u);
  assert.match(html, /不会自动填写或提交/u);
  assert.match(html, /copyText\(email, "邮箱已复制"\)/u);
  assert.match(html, /send\("copyText"/u);
  assert.doesNotMatch(html, /navigator\.clipboard/u);
  assert.match(html, /document\.addEventListener\("keydown"/u);
  assert.match(html, /document\.addEventListener\("keyup"/u);
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
        { id: "mailbox:free", providerId: "mock", address: "free@example.com", displayName: "free@example.com" },
        { id: "mailbox:gpt", providerId: "mock", address: "gpt@example.com", displayName: "gpt@example.com", gptRegistered: true }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      managedAccountEmailsAvailable: true,
      managedAccountEmails: ["LINKED@example.com"],
      registrationSessions: []
    }
  } });

  assert.doesNotMatch(renderedHtml, /linked@example\.com/iu);
  assert.match(renderedHtml, /free@example\.com/u);
  assert.match(renderedHtml, /gpt@example\.com/u);
  assert.match(renderedHtml, /GPT 已注册/u);
  assert.match(renderedHtml, /已自动隐藏 1 个/u);
});

test("registration mailbox library can show only emails without GPT registration", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

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
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:available", providerId: "mock", address: "available@example.com", displayName: "available@example.com", gptRegistered: false },
        { id: "mailbox:registered", providerId: "mock", address: "registered@example.com", displayName: "registered@example.com", gptRegistered: true }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      managedAccountEmailsAvailable: true,
      managedAccountEmails: [],
      registrationSessions: []
    }
  } });
  assert.match(renderedHtml, /available@example\.com/u);
  assert.match(renderedHtml, /registered@example\.com/u);

  documentListeners.get("change")({ target: {
    id: "registrationOnlyUnregisteredGpt",
    checked: true,
    matches() { return false; },
    closest() { return this; }
  } });

  assert.match(renderedHtml, /available@example\.com/u);
  assert.doesNotMatch(renderedHtml, /registered@example\.com/u);
  assert.match(renderedHtml, /id="registrationOnlyUnregisteredGpt" type="checkbox" checked/u);
});

test("registration mailbox library shows GPT age and filters registrations at seven days", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

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
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:old-gpt", providerId: "mock", address: "old-gpt@example.com", displayName: "old-gpt@example.com", gptRegistered: true, firstOpenAiEmailAt: new Date(now - 8 * day).toISOString() },
        { id: "mailbox:recent-gpt", providerId: "mock", address: "recent-gpt@example.com", displayName: "recent-gpt@example.com", gptRegistered: true, firstOpenAiEmailAt: new Date(now - 6 * day).toISOString() },
        { id: "mailbox:not-gpt", providerId: "mock", address: "not-gpt@example.com", displayName: "not-gpt@example.com", gptRegistered: false }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      managedAccountEmails: [],
      registrationSessions: []
    }
  } });

  assert.match(renderedHtml, /仅 GPT 注册 ≥ 7 天/u);
  assert.match(renderedHtml, /old-gpt@example\.com/u);
  assert.match(renderedHtml, /recent-gpt@example\.com/u);
  assert.match(renderedHtml, /GPT 已注册 \d+ 天/u);

  documentListeners.get("change")({ target: {
    id: "registrationOnlyGptSevenDays",
    checked: true,
    matches() { return false; },
    closest() { return this; }
  } });

  assert.match(renderedHtml, /id="registrationOnlyGptSevenDays" type="checkbox" checked/u);
  assert.match(renderedHtml, /old-gpt@example\.com/u);
  assert.doesNotMatch(renderedHtml, /recent-gpt@example\.com/u);
  assert.doesNotMatch(renderedHtml, /not-gpt@example\.com/u);
});

test("standalone registration panel preserves scroll position when selecting a mailbox", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let registrationStandalone;
  let registrationMailboxList;
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) {
      renderedHtml = value;
      registrationStandalone = { scrollTop: 0 };
      registrationMailboxList = { scrollTop: 0 };
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
      if (selector === ".registration-standalone") return registrationStandalone;
      if (selector === ".registration-mailbox-list") return registrationMailboxList;
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
  const stateListener = windowListeners.get("message");
  assert.ok(stateListener);
  const state = {
    mailboxes: [
      { id: "mailbox:first", providerId: "mock", address: "first@example.com", displayName: "first@example.com" },
      { id: "mailbox:second", providerId: "mock", address: "second@example.com", displayName: "second@example.com" }
    ],
    providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
    managedAccountEmailsAvailable: true,
    managedAccountEmails: [],
    registrationSessions: []
  };
  stateListener({ data: { type: "state", state } });
  registrationStandalone.scrollTop = 487;
  registrationMailboxList.scrollTop = 731;
  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "registration-select-mailbox", mailboxId: "mailbox:second" },
    closest() { return this; }
  } });

  assert.equal(registrationStandalone.scrollTop, 487);
  assert.equal(registrationMailboxList.scrollTop, 731);
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

test("completed GPT sessions keep manual helpers and expose Codex import termination", () => {
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
      mailboxes: [{ id: "mailbox:gpt", address: "gpt@example.com", displayName: "gpt@example.com", providerId: "mock" }],
      providers: [],
      managedAccountEmails: [],
      codexImportAvailable: true,
      codexImports: ["mailbox:gpt"],
      codexImportCancellable: true,
      phoneSources: [{ id: "liye", displayName: "LIYE" }],
      registrationKeyPool: {
        count: 1,
        available: 1,
        inUse: 0,
        keys: [{ id: "key:gpt", masked: "KEY…GPT", status: "available" }]
      },
      registrationSessions: [{
        id: "session:gpt",
        email: "gpt@example.com",
        mode: "manual-browser",
        importCodex: false,
        state: "completed",
        phoneOrder: { phase: "received", running: false },
        emailCode: { phase: "idle" }
      }]
    }
  } });

  assert.match(renderedHtml, /data-action="registration-refresh-email-code"/u);
  assert.match(renderedHtml, /data-action="registration-acquire-phone"[^>]*>开始取号/u);
  assert.match(renderedHtml, /<select id="registrationPhoneKey-session:gpt">/u);
  assert.match(renderedHtml, /data-action="registration-cancel-codex-import"/u);

  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "registration-cancel-codex-import", sessionId: "session:gpt" },
    closest() { return this; }
  } });
  assert.equal(messages.at(-1).action, "registrationCancelCodexImport");
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
  click({ target: {
    disabled: true,
    dataset: { action: "registration-cleanup-all" },
    closest() { return this; }
  } });

  assert.deepEqual(messages.filter((message) => message.action !== "ready").map((message) => ({ action: message.action, mailboxId: message.mailboxId })), [
    { action: "registrationDeleteMailbox", mailboxId: "mailbox:registration" },
    { action: "registrationCleanupAll", mailboxId: undefined }
  ]);
});

test("Mailbox panel fills the webview and lets the detail wheel scroll the layout", () => {
  const html = createMailboxPanelHtml();
  assert.match(html, /body \{ margin: 0; padding: 0; min-height: 100vh; overflow: hidden;/u);
  assert.match(html, /\.layout \{ flex: 1 1 auto;/u);
  assert.match(html, /\.layout \{ flex: 1 1 auto; display: flex; flex-direction: column;/u);
  assert.match(html, /\.layout > \.box:first-child \{ display: flex; flex-direction: column; flex: 0 0 760px; height: 760px; min-height: 760px;/u);
  assert.match(html, /\.mailbox-list \{ flex: 1; display: grid;/u);
  assert.match(html, /最久未续期/u);
  assert.match(html, /mailbox-card-time/u);
  assert.match(html, /mailboxActivityLabel\(mailbox\)/u);
  assert.match(html, /\.mailbox-list \{ flex: 1; display: grid; .*grid-auto-rows: max-content;/u);
  assert.match(html, /\.mailbox-row \{ display: block; width: 100%; min-width: 0; flex: 0 0 auto;/u);
  assert.match(html, /\.mailbox-account-filters \{ display: inline-flex; flex: 0 0 auto; flex-wrap: nowrap;/u);
  assert.match(html, /\.mailbox-list-tools label \{ display: inline-flex; align-items: center; gap: 1px;/u);
  assert.match(html, /\.mailbox-list-tools label input \{ flex: 0 0 auto; width: auto; min-width: 0; margin: 0; padding: 0;/u);
  assert.match(html, /\.mailbox-sort-controls \{ display: inline-flex; flex: 0 0 auto; align-items: center;/u);
  assert.match(html, /class="mailbox-sort-select"/u);
  assert.match(html, /data-action="toggle-mailbox-sort-direction"/u);
  assert.match(html, /mailbox-sort-arrow/u);
  assert.match(html, /\.mailbox-row-actions \{ display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 0 12px 8px;/u);
  assert.doesNotMatch(html, /data-action="toggle-registration"/u);
  assert.doesNotMatch(html, /class="top-actions">[^<]*<button[^>]*>注册助手/u);
  assert.match(html, /\.content \{ flex: 1 1 auto; min-height: 0; overflow: visible; overscroll-behavior: auto;/u);
  assert.match(html, /const layoutScrollTop = layout\?\.scrollTop \|\| 0;/u);
  assert.match(html, /if \(nextLayout\) nextLayout\.scrollTop = layoutScrollTop;/u);
  assert.match(html, /\.layout > \.box:first-child \{ flex-basis: 760px; height: 760px; min-height: 760px; \}/u);
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
  assert.match(html, /\.tag\.source/u);
  assert.match(html, /\.tag\.blocked/u);
  assert.match(html, /data-action="cancel-delete"/u);
  assert.match(html, /data-action="confirm-delete"/u);
  const selectedRenderer = html.slice(html.indexOf("function renderSelected(selected)"), html.indexOf("function renderMessageRow(message)"));
  assert.match(selectedRenderer, /const mailboxError = mailbox\.lastError/u);
  assert.doesNotMatch(html, /仅未出码/u);
  assert.match(html, /仅未接入 Codex/u);
  assert.match(html, /mailboxProviderFilter/u);
  assert.match(html, /function filterMailboxes\(/u);
  assert.match(html, /onlyUnlinkedCodex/u);
  assert.match(html, /onlyReauthorization/u);
  assert.doesNotMatch(html, /query-reauthorization-mailboxes/u);
  assert.match(html, /按邮箱来源筛选/u);
  assert.match(html, /全选当前结果/u);
  assert.match(html, /批量查询/u);
  assert.match(html, /批量监听/u);
  assert.match(html, /批量停止/u);
  assert.match(html, /批量删除/u);
});

test("Mailbox cards display renewal fallback time and sort renewal time in both directions", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  const app = { insertAdjacentHTML() {} };
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
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:recent", providerId: "mock", address: "recent@example.com", displayName: "recent@example.com", createdAt: 100, lastRenewalAt: 300 },
        { id: "mailbox:added", providerId: "mock", address: "added@example.com", displayName: "added@example.com", createdAt: 100 },
        { id: "mailbox:old", providerId: "mock", address: "old@example.com", displayName: "old@example.com", createdAt: 100, lastRenewalAt: 200 }
      ],
      selectedMailboxId: "mailbox:old",
      operations: [],
      providers: [{ id: "mock", displayName: "Mock", capabilities: { manualRenewal: true }, importSchema: {} }],
      codexImportAvailable: false,
      managedAccountEmails: []
    }
  } });

  assert.match(renderedHtml, /添加时间：/u);
  assert.match(renderedHtml, /上次续期：/u);
  const change = documentListeners.get("change");
  change({ target: { id: "mailboxSort", value: "renewal", matches() { return false; } } });
  assert.ok(renderedHtml.indexOf("added@example.com") < renderedHtml.indexOf("old@example.com"));
  assert.ok(renderedHtml.indexOf("old@example.com") < renderedHtml.indexOf("recent@example.com"));
  const click = documentListeners.get("click");
  click({ target: {
    disabled: false,
    dataset: { action: "toggle-mailbox-sort-direction" },
    closest() { return this; }
  } });
  assert.ok(renderedHtml.indexOf("recent@example.com") < renderedHtml.indexOf("old@example.com"));
  assert.ok(renderedHtml.indexOf("old@example.com") < renderedHtml.indexOf("added@example.com"));
  assert.match(renderedHtml, /mailbox-sort-arrow[^>]*>▼/u);
});

test("Mailbox latest code displays its query time and received time", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const app = {};
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
      mailboxes: [{
        id: "mailbox:code-time",
        providerId: "mock",
        address: "code-time@example.com",
        displayName: "code-time@example.com",
        latestCode: "208076"
      }],
      selectedMailboxId: "mailbox:code-time",
      selected: {
        mailbox: {
          id: "mailbox:code-time",
          providerId: "mock",
          address: "code-time@example.com",
          displayName: "code-time@example.com",
          latestCode: "208076"
        },
        detail: {
          fetchedAt: "2026-09-02T07:05:40.000Z",
          codes: ["208076"],
          messages: [{
            id: "message:code-time",
            subject: "OpenAI verification code",
            receivedAt: "2026-09-02T07:04:12.000Z",
            codes: ["208076"],
            body: "Your verification code is 208076"
          }]
        }
      },
      operations: [],
      codexImports: [],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      codexImportAvailable: false,
      managedAccountEmails: []
    }
  } });

  assert.match(app.innerHTML, /最近一次验证码/u);
  assert.match(app.innerHTML, /验证码 208076/u);
  assert.match(app.innerHTML, /查询于[^<]* · 收到于[^<]*/u);
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
        count: 7,
        available: 7,
        inUse: 0,
        keys: Array.from({ length: 7 }, (_, index) => ({ id: `key-${index + 1}`, masked: `KEY…-${index + 1}`, status: "available" }))
      },
      registrationSessions: [{
        id: "session:key-select",
        email: "key@example.com",
        state: "awaiting_phone_input",
        mode: "oauth",
        phoneOrder: { phase: "idle", running: false, order: { phone: "+861380000000" } }
      }]
    }
  } });

  const renderedHtml = app.innerHTML;
  const keySelectStart = renderedHtml.indexOf('<select id="registrationPhoneKey-session:key-select"');
  const keySelectEnd = renderedHtml.indexOf("</select>", keySelectStart);
  const keySelectHtml = renderedHtml.slice(keySelectStart, keySelectEnd);
  assert.match(keySelectHtml, /value="key-1" selected/u);
  assert.match(keySelectHtml, /value="key-5"/u);
  assert.doesNotMatch(keySelectHtml, /value="key-6"/u);
  assert.match(renderedHtml, /选择器仅显示前 5 个/u);
  assert.match(renderedHtml, /等待完整手机号/u);

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

test("Mailbox shows a guarded combined deletion action for a deactivated reauthorization account", () => {
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
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  windowListeners.get("message")({
    data: {
      type: "state",
      state: {
        mailboxes: [{
          id: "mailbox:deactivated",
          providerId: "mock",
          address: "deactivated@example.com",
          displayName: "deactivated@example.com",
          openaiAccountDeactivated: true,
          messageCount: 1,
          historyMode: "latest"
        }],
        selectedMailboxId: "mailbox:deactivated",
        selected: {
          mailbox: {
            id: "mailbox:deactivated",
            providerId: "mock",
            address: "deactivated@example.com",
            displayName: "deactivated@example.com",
            openaiAccountDeactivated: true,
            messageCount: 1,
            historyMode: "latest"
          },
          detail: { messages: [], codes: [] }
        },
        operations: [],
        codexImports: [],
        codexImportCancellable: false,
        providers: [{ id: "mock", displayName: "Mock", capabilities: { history: "latest", maxMessages: 1, manualRenewal: false }, importSchema: {} }],
        codexImportAvailable: false,
        managedAccountEmails: ["deactivated@example.com"],
        managedAccounts: [{ accountId: "codex-account-1", email: "deactivated@example.com", requiresReauthorization: true }],
        managedAccountRemovalAvailable: true
      }
    }
  });

  assert.match(app.innerHTML, /data-action="delete-mailbox-and-codex"/u);
  assert.match(app.innerHTML, /删除邮箱与 Codex 账号/u);
  const click = documentListeners.get("click");
  click({ target: { disabled: false, dataset: { action: "delete-mailbox-and-codex", mailboxId: "mailbox:deactivated" }, closest() { return this; } } });
  assert.match(insertedModal, /对应 Codex 账号/u);
  assert.match(insertedModal, /不可恢复/u);
  click({ target: { disabled: false, dataset: { action: "confirm-delete" }, closest() { return this; } } });

  const deleteMessage = messages.at(-1);
  assert.equal(deleteMessage.action, "deleteMailboxAndCodex");
  assert.equal(deleteMessage.mailboxId, "mailbox:deactivated");
});

test("Mailbox offers one bulk action for all deactivated reauthorization matches", () => {
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
    body: { insertAdjacentHTML(_position, value) { insertedModal = value; } },
    getElementById(id) { return id === "app" ? app : id === "notice" ? notice : null; },
    querySelector(selector) {
      if (selector === ".modal-backdrop" && insertedModal) return { remove() { insertedModal = ""; } };
      return null;
    },
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

  windowListeners.get("message")({
    data: {
      type: "state",
      state: {
        mailboxes: [
          { id: "mailbox:eligible", providerId: "mock", address: "eligible@example.com", displayName: "eligible@example.com", openaiAccountDeactivated: true },
          { id: "mailbox:healthy", providerId: "mock", address: "healthy@example.com", displayName: "healthy@example.com", openaiAccountDeactivated: true }
        ],
        selectedMailboxId: "mailbox:eligible",
        selected: { mailbox: { id: "mailbox:eligible", providerId: "mock", address: "eligible@example.com", openaiAccountDeactivated: true }, detail: { messages: [], codes: [] } },
        operations: [],
        codexImports: [],
        providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
        codexImportAvailable: false,
        managedAccountEmails: ["eligible@example.com", "healthy@example.com"],
        managedAccounts: [
          { accountId: "codex-eligible", email: "eligible@example.com", requiresReauthorization: true },
          { accountId: "codex-healthy", email: "healthy@example.com", requiresReauthorization: false }
        ],
        managedAccountDirectoryAvailable: true,
        managedAccountRemovalAvailable: true
      }
    }
  });

  assert.match(app.innerHTML, /OpenAI 封禁：2/u);
  assert.match(app.innerHTML, /id="onlyReauthorization"/u);
  assert.doesNotMatch(app.innerHTML, /query-reauthorization-mailboxes/u);
  assert.doesNotMatch(app.innerHTML, /查询需重新授权账号邮箱/u);
  assert.match(app.innerHTML, /删除封禁账号（1）/u);
  const change = documentListeners.get("change");
  change({ target: { id: "onlyReauthorization", checked: true, matches() { return false; }, closest() { return this; } } });
  assert.match(app.innerHTML, /eligible@example\.com/u);
  assert.doesNotMatch(app.innerHTML, /healthy@example\.com/u);
  const click = documentListeners.get("click");
  click({ target: { disabled: false, dataset: { action: "delete-deactivated-mailboxes" }, closest() { return this; } } });
  assert.match(insertedModal, /将删除 1 个/u);
  assert.match(insertedModal, /需要重新授权/u);
  click({ target: { disabled: false, dataset: { action: "confirm-delete" }, closest() { return this; } } });

  const deleteMessage = messages.at(-1);
  assert.equal(deleteMessage.type, "mailbox:action");
  assert.equal(deleteMessage.action, "deleteDeactivatedMailboxes");
});

test("Mailbox can filter only OpenAI-deactivated mailboxes", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

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
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:blocked", providerId: "mock", address: "blocked@example.com", displayName: "blocked@example.com", openaiAccountDeactivated: true },
        { id: "mailbox:ordinary", providerId: "mock", address: "ordinary@example.com", displayName: "ordinary@example.com", openaiAccountDeactivated: false }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      operations: [],
      codexImports: []
    }
  } });

  assert.match(renderedHtml, /id="onlyOpenAiDeactivated"/u);
  assert.match(renderedHtml, /blocked@example\.com/u);
  assert.match(renderedHtml, /ordinary@example\.com/u);

  documentListeners.get("change")({ target: {
    id: "onlyOpenAiDeactivated",
    checked: true,
    matches() { return false; },
    closest() { return this; }
  } });

  assert.match(renderedHtml, /id="onlyOpenAiDeactivated" type="checkbox" checked/u);
  assert.match(renderedHtml, /blocked@example\.com/u);
  assert.doesNotMatch(renderedHtml, /ordinary@example\.com/u);
  assert.match(renderedHtml, />1\/2<\/span>/u);
});

test("Mailbox tags use compact semantic colors and do not expose code_found", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const app = { insertAdjacentHTML() {} };
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
      mailboxes: [{
        id: "mailbox:tagged",
        providerId: "mock",
        address: "tagged@example.com",
        displayName: "tagged@example.com",
        openaiAccountDeactivated: true,
        gptRegistered: true,
        latestCode: "123456",
        lastStatus: "code_found",
        lastError: { code: "temporary_failure", message: "provider detail" }
      }],
      selectedMailboxId: "mailbox:tagged",
      selected: {
        mailbox: {
          id: "mailbox:tagged",
          providerId: "mock",
          address: "tagged@example.com",
          displayName: "tagged@example.com",
          openaiAccountDeactivated: true,
          gptRegistered: true,
          latestCode: "123456",
          lastStatus: "code_found",
          lastError: { code: "temporary_failure", message: "provider detail" }
        },
        detail: { messages: [], codes: [] }
      },
      operations: [],
      codexImports: [],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      codexImportAvailable: true,
      managedAccountEmails: ["tagged@example.com"],
      managedAccounts: [],
      managedAccountDirectoryAvailable: true,
      managedAccountRemovalAvailable: false
    }
  } });

  assert.match(app.innerHTML, /class="tag source">mock/u);
  assert.match(app.innerHTML, /class="tag success">Codex 已接入/u);
  assert.doesNotMatch(app.innerHTML, /GPT 已注册/u);
  assert.match(app.innerHTML, /class="tag success">验证码 123456/u);
  assert.match(app.innerHTML, /class="tag blocked">OpenAI 封禁/u);
  assert.match(app.innerHTML, /class="tag error"[^>]*>temporary_failure/u);
  assert.doesNotMatch(app.innerHTML, /code_found/u);
});
