"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createMailboxPanelHtml, createRegistrationPanelHtml } = require("../../src/ui/panel.cjs");

test("registration 2FA block creates a new entry and shows the live code expiry state", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
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
    getElementById(id) { return id === "app" ? app : id === "notice" ? { style: {} } : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const window = { addEventListener(type, listener) { windowListeners.set(type, listener); } };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  const state = {
    mailboxes: [{ id: "mailbox:one", address: "one@example.com", displayName: "one@example.com", providerId: "mock", totpLinked: true }],
    providers: [],
    totp: { configured: true, error: "" },
    totpLinks: {},
    registrationSessions: [{
      id: "session:totp",
      email: "one@example.com",
      mode: "manual-browser",
      state: "awaiting_manual_registration",
      emailCode: { phase: "idle" },
      phoneOrder: { phase: "idle", running: false }
    }]
  };
  windowListeners.get("message")({ data: { type: "state", state } });
  assert.match(renderedHtml, /data-action="registration-totp-create"/u);
  assert.match(renderedHtml, /2FA 已绑定/u);
  assert.match(renderedHtml, /otpauth:\/\/totp/u);
  assert.doesNotMatch(renderedHtml, /registration-totp-link|registrationTotpAccount/u);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "totpOpen",
    mailboxId: "mailbox:one"
  });

  windowListeners.get("message")({ data: {
    type: "totp-state",
    mailboxId: "mailbox:one",
    state: {
      configured: true,
      link: { mailboxId: "mailbox:one", accountId: "7", service: "OpenAI", account: "one@example.com" },
      account: { id: "7", service: "OpenAI", account: "one@example.com" },
      otp: { code: "123456", generatedAt: Math.floor(Date.now() / 1000) - 31, period: 30 },
      accounts: [],
      error: ""
    }
  } });
  assert.match(renderedHtml, /123456/u);
  assert.doesNotMatch(renderedHtml, /data-action="registration-totp-query"/u);
  assert.match(renderedHtml, /data-registration-totp-countdown/u);
  assert.match(renderedHtml, /剩余/u);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "totpQuery",
    mailboxId: "mailbox:one",
    registrationAuto: true
  });
  messages.length = 0;
  windowListeners.get("pagehide")({});
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "registrationTotpStop"
  });
});

test("registration rerenders preserve the focused input caret", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  let renderedHtml = "";
  let activeInput = null;
  let restoredSelection;
  const input = {
    id: "phoneInput:session:caret",
    selectionStart: 4,
    selectionEnd: 4,
    disabled: false,
    focus() { this.focused = true; },
    setSelectionRange(start, end) { restoredSelection = [start, end]; }
  };
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const document = {
    get activeElement() { return activeInput; },
    body: { insertAdjacentHTML() {} },
    getElementById(id) {
      if (id === "app") return app;
      if (id === input.id) return input;
      return id === "notice" ? {} : null;
    },
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

  const state = {
    mailboxes: [],
    providers: [],
    registrationSessions: [{
      id: "session:caret",
      email: "caret@example.com",
      mode: "oauth",
      state: "awaiting_phone_input",
      phoneOrder: { phase: "idle", running: false },
      emailCode: { phase: "idle" }
    }]
  };
  windowListeners.get("message")({ data: { type: "state", state } });
  activeInput = input;
  windowListeners.get("message")({ data: { type: "state", state } });

  assert.equal(input.focused, true);
  assert.deepEqual(restoredSelection, [4, 4]);
});

test("N replaces and copies the active phone only while the registration phone panel is open", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let phoneOrderElement = {
    hidden: false,
    dataset: { registrationPhoneOrderSessionId: "session:phone" },
    getClientRects() { return [{}]; }
  };
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; }
  });
  const notice = { style: {} };
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? notice : null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === "[data-registration-phone-order-session-id]" ? [phoneOrderElement] : [];
    },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const window = { addEventListener(type, listener) { windowListeners.set(type, listener); } };
  vm.runInNewContext(script, {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  const buildState = (phone, orderId, phase = "polling") => ({
    mailboxes: [],
    providers: [],
    registrationSessions: [{
      id: "session:phone",
      email: "phone@example.com",
      mode: "oauth",
      state: "awaiting_phone_input",
      phoneOrder: { phase, running: true, order: { id: orderId, phone, smsCode: "" } },
      emailCode: { phase: "idle" }
    }]
  });

  windowListeners.get("message")({ data: { type: "state", state: buildState("+447000000001", "order-1") } });
  messages.length = 0;
  let prevented = false;
  documentListeners.get("keydown")({
    key: "n",
    repeat: false,
    target: { tagName: "BODY" },
    preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "registrationReplacePhone",
    sessionId: "session:phone"
  });

  windowListeners.get("message")({ data: { type: "state", state: buildState("+447000000002", "order-2") } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "copyText",
    text: "+447000000002",
    successMessage: "新手机号已复制"
  });

  messages.length = 0;
  phoneOrderElement.hidden = true;
  documentListeners.get("keydown")({ key: "n", repeat: false, target: { tagName: "BODY" }, preventDefault() {} });
  assert.equal(messages.length, 0);
  phoneOrderElement.hidden = false;
  document.activeElement = { tagName: "INPUT" };
  documentListeners.get("keydown")({ key: "n", repeat: false, target: document.activeElement, preventDefault() {} });
  assert.equal(messages.length, 0);
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

test("registration mailbox library sorts by each field and toggles direction with the arrow", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let renderCount = 0;
  let registrationRows = "";
  const extractRegistrationRows = (value) => {
    const marker = '<div class="registration-mailbox-list">';
    const start = value.indexOf(marker);
    if (start < 0) return "";
    const bodyStart = start + marker.length;
    const end = value.indexOf('</div></div><div class="registration-standalone-content">', bodyStart);
    return end < 0 ? "" : value.slice(bodyStart, end);
  };
  const sortArrow = { textContent: "▲" };
  const sortDirectionButton = {
    title: "",
    setAttribute(name, value) { this[name] = value; },
    querySelector() { return sortArrow; }
  };
  const registrationMailboxList = {
    scrollTop: 0,
    get innerHTML() { return registrationRows; },
    set innerHTML(value) { registrationRows = value; }
  };
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) {
      renderCount += 1;
      renderedHtml = value;
      registrationRows = extractRegistrationRows(value);
    }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector(selector) {
      if (selector === ".registration-mailbox-list") return registrationMailboxList;
      if (selector === '[data-action="toggle-registration-mailbox-sort-direction"]') return sortDirectionButton;
      return null;
    },
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
        { id: "mailbox:alpha", providerId: "mock", address: "alpha@example.com", displayName: "Alpha", lastQueryAt: 300, lastRenewalAt: 200, gptRegistered: true, firstOpenAiEmailAt: new Date(now - 10 * day).toISOString() },
        { id: "mailbox:bravo", providerId: "mock", address: "bravo@example.com", displayName: "Bravo", lastQueryAt: 100, lastRenewalAt: 400, gptRegistered: true, firstOpenAiEmailAt: new Date(now - 2 * day).toISOString() },
        { id: "mailbox:charlie", providerId: "mock", address: "charlie@example.com", displayName: "Charlie", lastQueryAt: 200, lastRenewalAt: 100, gptRegistered: true, firstOpenAiEmailAt: new Date(now - 5 * day).toISOString() },
        { id: "mailbox:not-gpt", providerId: "mock", address: "not-gpt@example.com", displayName: "Not GPT", gptRegistered: false }
      ],
      providers: [{ id: "mock", displayName: "Mock", capabilities: {}, importSchema: {} }],
      managedAccountEmails: [],
      registrationSessions: []
    }
  } });

  const assertOrderIn = (source, ...addresses) => {
    let previous = -1;
    for (const address of addresses) {
      const index = source.indexOf(address);
      assert.ok(index > previous, `${address} should follow the previous mailbox`);
      previous = index;
    }
  };
  const assertOrder = (...addresses) => assertOrderIn(renderedHtml, ...addresses);

  assertOrder("alpha@example.com", "bravo@example.com", "charlie@example.com");
  const renderCountBeforeSort = renderCount;
  const change = documentListeners.get("change");
  change({ target: { id: "registrationMailboxSort", value: "query", matches() { return false; }, closest() { return this; } } });
  assertOrderIn(registrationRows, "bravo@example.com", "charlie@example.com", "alpha@example.com");
  assert.equal(renderCount, renderCountBeforeSort);

  const click = documentListeners.get("click");
  click({ target: {
    disabled: false,
    dataset: { action: "toggle-registration-mailbox-sort-direction" },
    closest() { return this; }
  } });
  assertOrderIn(registrationRows, "alpha@example.com", "charlie@example.com", "bravo@example.com");
  assert.equal(sortArrow.textContent, "▼");
  assert.equal(sortDirectionButton["aria-label"], "当前降序，点击切换为升序");

  change({ target: { id: "registrationMailboxSort", value: "renewal", matches() { return false; }, closest() { return this; } } });
  assertOrderIn(registrationRows, "bravo@example.com", "alpha@example.com", "charlie@example.com");
  click({ target: {
    disabled: false,
    dataset: { action: "toggle-registration-mailbox-sort-direction" },
    closest() { return this; }
  } });
  assertOrderIn(registrationRows, "charlie@example.com", "alpha@example.com", "bravo@example.com");

  change({ target: { id: "registrationMailboxSort", value: "gptRegistration", matches() { return false; }, closest() { return this; } } });
  assertOrderIn(registrationRows, "not-gpt@example.com", "bravo@example.com", "charlie@example.com", "alpha@example.com");
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
  let registrationCountryList;
  let registrationOperatorList;
  const resetScrollNodes = () => {
    registrationStandalone = { scrollTop: 0, scrollLeft: 0 };
    registrationMailboxList = { scrollTop: 0, scrollLeft: 0 };
    registrationCountryList = {
      scrollTop: 0,
      scrollLeft: 0,
      dataset: { scrollPreserve: "registration-fivesim-country-list-session:fivesim" }
    };
    registrationOperatorList = {
      scrollTop: 0,
      scrollLeft: 0,
      dataset: { scrollPreserve: "registration-fivesim-operator-list-session:fivesim" }
    };
  };
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) {
      renderedHtml = value;
      resetScrollNodes();
    }
  });
  resetScrollNodes();
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
    querySelectorAll(selector) {
      if (selector === ".registration-fivesim-country-list") return [registrationCountryList];
      if (selector === ".registration-fivesim-operator-list") return [registrationOperatorList];
      return [];
    },
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
  registrationCountryList.scrollTop = 113;
  registrationCountryList.scrollLeft = 7;
  registrationOperatorList.scrollTop = 257;
  registrationOperatorList.scrollLeft = 11;
  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "registration-select-mailbox", mailboxId: "mailbox:second" },
    closest() { return this; }
  } });

  assert.equal(registrationStandalone.scrollTop, 487);
  assert.equal(registrationMailboxList.scrollTop, 731);
  assert.equal(registrationCountryList.scrollTop, 113);
  assert.equal(registrationCountryList.scrollLeft, 7);
  assert.equal(registrationOperatorList.scrollTop, 257);
  assert.equal(registrationOperatorList.scrollLeft, 11);
  assert.equal(messages.at(-1).action, "ready");
});

test("Mailbox provider filter refreshes rows without replacing the active controls", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let renderCount = 0;
  let mailboxRows = "";
  const mailboxList = {
    scrollTop: 0,
    get innerHTML() { return mailboxRows; },
    set innerHTML(value) { mailboxRows = value; }
  };
  const mailboxCount = { textContent: "" };
  const selectionCount = { textContent: "" };
  const messages = [];
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderCount += 1; renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector(selector) {
      if (selector === ".mailbox-list") return mailboxList;
      if (selector === '[data-role="mailbox-count"]') return mailboxCount;
      if (selector === ".selection-tools > span") return selectionCount;
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

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [
        { id: "mailbox:a", providerId: "a", address: "a@example.com", displayName: "A" },
        { id: "mailbox:b", providerId: "b", address: "b@example.com", displayName: "B" }
      ],
      providers: [
        { id: "a", displayName: "Provider A", capabilities: {}, importSchema: {} },
        { id: "b", displayName: "Provider B", capabilities: {}, importSchema: {} }
      ],
      operations: [],
      codexImports: [],
      managedAccountEmails: []
    }
  } });

  assert.match(renderedHtml, /<option value="a"[^>]*>Provider A<\/option>/u);
  assert.doesNotMatch(renderedHtml, /Provider A（a）/u);

  const renderCountBeforeFilter = renderCount;
  documentListeners.get("change")({ target: {
    id: "mailboxProviderFilter",
    value: "b",
    matches() { return false; },
    closest() { return this; }
  } });

  assert.equal(renderCount, renderCountBeforeFilter);
  assert.match(mailboxRows, /b@example\.com/u);
  assert.doesNotMatch(mailboxRows, /a@example\.com/u);
  assert.equal(mailboxCount.textContent, "1/2");
  assert.match(selectionCount.textContent, /1$/u);
  assert.match(mailboxRows, /<span class="tag source">Provider B<\/span>/u);
  assert.match(mailboxRows, /data-action="copy-mailbox-email" data-email="b@example\.com"/u);

  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "copy-mailbox-email", email: "b@example.com" },
    closest() { return this; }
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "copyText",
    text: "b@example.com",
    successMessage: "邮箱已复制"
  });
});

test("Mailbox batch operations display progress for query, listening, and renewal", () => {
  const html = createMailboxPanelHtml();
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

  windowListeners.get("message")({
    data: {
      type: "state",
      state: {
        mailboxes: [
          { id: "mailbox:query", providerId: "mock", address: "query@example.com", displayName: "Query" },
          { id: "mailbox:wait", providerId: "mock", address: "wait@example.com", displayName: "Wait" },
          { id: "mailbox:renewal", providerId: "mock", address: "renewal@example.com", displayName: "Renewal" }
        ],
        providers: [{ id: "mock", displayName: "Mock", capabilities: { manualRenewal: true }, importSchema: {} }],
        operations: [
          { mailboxId: "mailbox:query", kind: "query", batchId: "query-batch", progress: { completed: 3, total: 10 } },
          { mailboxId: "mailbox:wait", kind: "wait", batchId: "wait-batch", progress: { completed: 2, total: 3 } },
          { mailboxId: "mailbox:renewal", kind: "renewal", batchId: "renewal-batch", progress: { completed: 1, total: 4 } }
        ]
      }
    }
  });

  assert.match(renderedHtml, /查询进度/u);
  assert.match(renderedHtml, /已查询 3\/10/u);
  assert.match(renderedHtml, /aria-valuenow="3"/u);
  assert.match(renderedHtml, /style="width:30%"/u);
  assert.match(renderedHtml, /监听进度/u);
  assert.match(renderedHtml, /已监听 2\/3/u);
  assert.match(renderedHtml, /续期进度/u);
  assert.match(renderedHtml, /已续期 1\/4/u);
});

test("registration provider filter refreshes rows without replacing the registration controls", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let renderCount = 0;
  let mailboxRows = "";
  const mailboxList = {
    scrollTop: 0,
    get innerHTML() { return mailboxRows; },
    set innerHTML(value) { mailboxRows = value; }
  };
  const mailboxCount = { textContent: "" };
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderCount += 1; renderedHtml = value; }
  });
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector(selector) {
      if (selector === ".registration-mailbox-list") return mailboxList;
      if (selector === '[data-role="registration-mailbox-count"]') return mailboxCount;
      return null;
    },
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
        { id: "mailbox:a", providerId: "a", address: "a@example.com", displayName: "A" },
        { id: "mailbox:b", providerId: "b", address: "b@example.com", displayName: "B" }
      ],
      providers: [
        { id: "a", displayName: "Provider A", capabilities: {}, importSchema: {} },
        { id: "b", displayName: "Provider B", capabilities: {}, importSchema: {} }
      ],
      managedAccountEmails: [],
      registrationSessions: []
    }
  } });

  assert.match(renderedHtml, /<option value="a"[^>]*>Provider A<\/option>/u);
  assert.doesNotMatch(renderedHtml, /Provider A（a）/u);

  const renderCountBeforeFilter = renderCount;
  documentListeners.get("change")({ target: {
    id: "registrationMailboxProviderFilter",
    value: "b",
    matches() { return false; },
    closest() { return this; }
  } });

  assert.equal(renderCount, renderCountBeforeFilter);
  assert.match(mailboxRows, /b@example\.com/u);
  assert.doesNotMatch(mailboxRows, /a@example\.com/u);
  assert.equal(mailboxCount.textContent, "1/2");
});

test("provider selects update dependent form fields without rebuilding their modal", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const runScenario = (action, providerSelectId, inputRole, expectedPlaceholder) => {
    const windowListeners = new Map();
    const documentListeners = new Map();
    let renderedHtml = "";
    let renderCount = 0;
    let insertedModal = "";
    const dependentInput = { placeholder: "" };
    const app = {};
    Object.defineProperty(app, "innerHTML", {
      configurable: true,
      get() { return renderedHtml; },
      set(value) { renderCount += 1; renderedHtml = value; }
    });
    const document = {
      activeElement: null,
      body: { insertAdjacentHTML(_position, value) { insertedModal = value; } },
      getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
      querySelector(selector) {
        if (selector === '[data-role="' + inputRole + '"]') return dependentInput;
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
      acquireVsCodeApi: () => ({ postMessage() {} }),
      console
    });

    windowListeners.get("message")({ data: {
      type: "state",
      state: {
        mailboxes: [{ id: "mailbox:edit", providerId: "a", address: "edit@example.com", displayName: "Edit" }],
        selectedMailboxId: "mailbox:edit",
        providers: [
          { id: "a", displayName: "Provider A", capabilities: {}, importSchema: { placeholder: "A format", description: "A description" } },
          { id: "b", displayName: "Provider B", capabilities: {}, importSchema: { placeholder: expectedPlaceholder, description: "B description" } }
        ],
        operations: [],
        codexImports: [],
        managedAccountEmails: []
      }
    } });

    const click = documentListeners.get("click");
    click({ target: {
      disabled: false,
      dataset: { action, mailboxId: "mailbox:edit" },
      closest() { return this; }
    } });
    assert.ok(insertedModal);
    assert.doesNotMatch(insertedModal, /Provider A（a）/u);
    const renderCountBeforeChange = renderCount;
    documentListeners.get("change")({ target: {
      id: providerSelectId,
      value: "b",
      matches() { return false; },
      closest() { return this; }
    } });
    assert.equal(renderCount, renderCountBeforeChange);
    assert.equal(dependentInput.placeholder, expectedPlaceholder);
  };

  runScenario("open-import", "providerId", "import-credential-input", "B import format");
  runScenario("edit-mailbox", "editProviderId", "edit-credential-input", "B edit format");
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
  assert.match(renderedHtml, /class="registration-copy-email-actions"/u);
  assert.match(renderedHtml, /class="registration-copy-email-button"[^>]*data-action="registration-copy-email"/u);
  assert.ok(renderedHtml.indexOf('data-action="registration-copy-email"') > renderedHtml.indexOf('data-action="registration-cleanup"'));

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
  assert.match(renderedHtml, /mailbox-card-time warning[^>]*>上次续期：/u);
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
  const documentListeners = new Map();
  const messages = [];
  const app = {};
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
  assert.match(app.innerHTML, /data-action="copy-mailbox-email" data-email="code-time@example\.com" title="复制账号">复制账号<\/button>/u);
  assert.match(app.innerHTML, /查询于[^<]* · 收到于[^<]*/u);

  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "copy-mailbox-email", email: "code-time@example.com" },
    closest() { return this; }
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "mailbox:action",
    action: "copyText",
    text: "code-time@example.com",
    successMessage: "邮箱已复制"
  });
});

test("selecting an available registration key enables phone ordering", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  const acquireButton = { dataset: { sessionId: "session:key-select" }, disabled: true };
  const messages = [];
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
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  windowListeners.get("message")({ data: {
    type: "state",
    state: {
      mailboxes: [],
      providers: [],
      phoneSources: [
        { id: "liye", displayName: "LIYE", websiteUrl: "https://liye.5x20.cn" },
        { id: "other", displayName: "Other", websiteUrl: "https://example.com" }
      ],
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
  assert.match(renderedHtml, /LIYE/u);

  const selected = {
    id: "registrationPhoneKey-session:key-select",
    value: "key-1",
    closest() { return this; },
    matches() { return false; }
  };
  documentListeners.get("change")({ target: selected });
  assert.equal(acquireButton.disabled, false);

  documentListeners.get("change")({ target: {
    id: "registrationPhoneSource-session:key-select",
    value: "other",
    matches() { return false; },
    closest() { return this; }
  } });
  assert.match(app.innerHTML, /Other/u);
  assert.match(app.innerHTML, /https:\/\/example\.com/u);
  documentListeners.get("click")({ target: {
    disabled: false,
    dataset: { action: "registration-acquire-phone", sessionId: "session:key-select" },
    closest() { return this; }
  } });
  assert.equal(messages.at(-1).sourceId, "other");
  assert.equal(messages.at(-1).keyId, "key-1");
});

test("changing the registration phone source toggles its panels without rebuilding the form", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const windowListeners = new Map();
  const documentListeners = new Map();
  let renderedHtml = "";
  let renderCount = 0;
  const app = {};
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return renderedHtml; },
    set(value) { renderedHtml = value; renderCount += 1; }
  });
  const acquireButton = { dataset: { sessionId: "session:source-partial" }, disabled: true };
  const liyePanel = { dataset: { registrationPhoneSourcePanel: "liye" }, hidden: false };
  const fiveSimPanel = { dataset: { registrationPhoneSourcePanel: "fivesim" }, hidden: true };
  const sourceRoot = {
    dataset: { registrationPhoneSourceRoot: "session:source-partial" },
    querySelectorAll(selector) {
      return selector === "[data-registration-phone-source-panel]" ? [liyePanel, fiveSimPanel] : [];
    }
  };
  const document = {
    activeElement: null,
    body: { insertAdjacentHTML() {} },
    getElementById(id) { return id === "app" ? app : id === "notice" ? {} : null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "[data-registration-phone-source-root]") return [sourceRoot];
      if (selector === '[data-action="registration-acquire-phone"]') return [acquireButton];
      return [];
    },
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
      mailboxes: [],
      providers: [],
      phoneSources: [
        { id: "liye", displayName: "LIYE", credentialType: "key" },
        { id: "fivesim", displayName: "5SIM", credentialType: "api-token" }
      ],
      registrationFiveSimToken: { configured: true, masked: "five…oken" },
      registrationKeyPool: { count: 0, available: 0, inUse: 0, keys: [] },
      registrationSessions: [{
        id: "session:source-partial",
        email: "source@example.com",
        mode: "manual-browser",
        state: "awaiting_phone_input",
        phoneOrder: { phase: "idle", running: false, card: { source: "liye" }, catalog: [] },
        emailCode: { phase: "idle" }
      }]
    }
  } });
  const beforeChange = renderCount;

  documentListeners.get("change")({ target: {
    id: "registrationPhoneSource-session:source-partial",
    value: "fivesim",
    matches() { return false; },
    closest() { return this; }
  } });

  assert.equal(renderCount, beforeChange);
  assert.equal(liyePanel.hidden, true);
  assert.equal(fiveSimPanel.hidden, false);
});

test("5SIM registration panel shows balance, price-sorted offers and independent filters", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
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
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  const state = {
      mailboxes: [{ id: "mailbox:fivesim", address: "five@example.com", displayName: "five@example.com", providerId: "mock" }],
      providers: [],
      phoneSources: [
        { id: "liye", displayName: "LIYE", credentialType: "key" },
        { id: "fivesim", displayName: "5SIM", credentialType: "api-token", websiteUrl: "https://5sim.net" }
      ],
      registrationFiveSimToken: { configured: true, masked: "five…oken" },
      registrationFiveSimExchangeRate: { rate: 6.8, date: "2026-09-06", stale: false },
      registrationKeyPool: { count: 0, available: 0, inUse: 0, keys: [] },
      registrationSessions: [{
        id: "session:fivesim",
        email: "five@example.com",
        mode: "manual-browser",
        state: "awaiting_manual_registration",
        phoneOrder: {
          phase: "idle",
          running: false,
          card: { source: "fivesim", balance: 12.5, frozenBalance: 0.25, rating: 96, updatedAt: Date.now() },
          selection: { country: "england", operator: "any", product: "openai" },
          catalog: [
            { country: "usa", countryName: "USA", prefix: "+1", operator: "any", count: 4, successRate: 97, price: 0.08, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "virtual66", count: 444383, successRate: 59.38, price: 0.09, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "virtual60", count: 41831, instantSuccessRate: 0, averageSuccessRate: 6.19, successRate: 6.19, price: 0.0609, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "virtual58", count: 689, successRate: 25.88, price: 0.08, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "lowrate", count: 10, successRate: 0.5, price: 0.01, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "zeronumber", count: 10, successRate: 0, price: 0.015, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "zeropercent", count: 10, successRate: "0%", price: 0.02, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "zerorate", count: 10, rate: 0, price: 0.025, product: "openai" },
            { country: "england", countryName: "England", prefix: "+44", operator: "missingrate", count: 10, price: 0.03, product: "openai" }
          ]
        },
        emailCode: { phase: "idle" }
      }]
  };
  windowListeners.get("message")({ data: { type: "state", state } });

  assert.match(renderedHtml, /当前余额/u);
  assert.match(renderedHtml, /\$12\.50/u);
  assert.match(renderedHtml, /registrationFiveSimPriceMax-session:fivesim/u);
  assert.match(renderedHtml, /registrationFiveSimSuccessMin-session:fivesim/u);
  assert.match(renderedHtml, /最高价格/u);
  assert.match(renderedHtml, /最低成功率/u);
  assert.match(renderedHtml, /value="0\.1"/u);
  assert.match(renderedHtml, /\$0\.0609\(¥0\.43\)/u);
  assert.match(renderedHtml, /含 2\.9% 手续费/u);
  assert.match(renderedHtml, /最低价条目：virtual60/u);
  assert.match(renderedHtml, /即时 0% · 平均 6.19%/u);
  assert.match(renderedHtml, /接码率最高/u);
  assert.match(renderedHtml, /最低价/u);
  assert.match(renderedHtml, /\$0\.0609/u);
  assert.match(renderedHtml, /virtual66/u);
  assert.match(renderedHtml, /registration-fivesim-country-list/u);
  assert.match(renderedHtml, /data-scroll-preserve="registration-fivesim-country-list-session:fivesim"/u);
  assert.match(renderedHtml, /data-scroll-preserve="registration-fivesim-operator-list-session:fivesim"/u);
  assert.match(html, /\.registration-fivesim-country-list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(html, /\.registration-fivesim-country-list \{ grid-template-columns: 1fr; \}/u);
  assert.match(renderedHtml, /registration-fivesim-operator-list/u);
  assert.doesNotMatch(renderedHtml, /lowrate/u);
  assert.doesNotMatch(renderedHtml, /zeronumber/u);
  assert.doesNotMatch(renderedHtml, /zeropercent/u);
  assert.doesNotMatch(renderedHtml, /zerorate/u);
  assert.doesNotMatch(renderedHtml, /missingrate/u);
  assert.ok(renderedHtml.indexOf("England") < renderedHtml.indexOf("USA"));
  assert.match(renderedHtml, /data-registration-phone-source-panel="liye" hidden/u);
  assert.match(renderedHtml, /data-registration-phone-source-panel="fivesim"/u);
  const autoRefreshMessages = messages.filter((message) => message.action === "registrationRefreshFiveSim");
  assert.equal(autoRefreshMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(autoRefreshMessages[0])), {
    type: "mailbox:action",
    action: "registrationRefreshFiveSim",
    sessionId: "session:fivesim",
    country: "england",
    operator: "virtual60",
    product: "openai"
  });
  windowListeners.get("message")({ data: { type: "state", state } });
  assert.equal(messages.filter((message) => message.action === "registrationRefreshFiveSim").length, 1);
});

test("registration panel refreshes 5SIM once for a mailbox session regardless of the selected phone source", () => {
  const html = createRegistrationPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
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
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    console
  });

  const state = {
    mailboxes: [{ id: "mailbox:any", address: "any@example.com", displayName: "any@example.com", providerId: "mock" }],
    providers: [],
    phoneSources: [
      { id: "liye", displayName: "LIYE", credentialType: "key" },
      { id: "fivesim", displayName: "5SIM", credentialType: "api-token" }
    ],
    registrationFiveSimToken: { configured: true, masked: "five…oken" },
    registrationSessions: [{
      id: "session:any-mailbox",
      email: "any@example.com",
      mode: "oauth",
      state: "awaiting_oauth",
      phoneOrder: { phase: "idle", running: false, card: { source: "liye" } },
      emailCode: { phase: "idle" }
    }]
  };
  windowListeners.get("message")({ data: { type: "state", state } });

  const refreshMessages = messages.filter((message) => message.action === "registrationRefreshFiveSim");
  assert.equal(refreshMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(refreshMessages[0])), {
    type: "mailbox:action",
    action: "registrationRefreshFiveSim",
    sessionId: "session:any-mailbox",
    country: "",
    operator: "any",
    product: "openai"
  });

  windowListeners.get("message")({ data: { type: "state", state } });
  assert.equal(messages.filter((message) => message.action === "registrationRefreshFiveSim").length, 1);
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
        totpLinked: true,
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
          totpLinked: true,
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

  assert.match(app.innerHTML, /class="tag source">Mock/u);
  assert.match(app.innerHTML, /class="tag success">Codex 已接入/u);
  assert.doesNotMatch(app.innerHTML, /GPT 已注册/u);
  assert.match(app.innerHTML, /class="tag success">2FA 已绑定/u);
  assert.doesNotMatch(app.innerHTML, /class="tag success">验证码 123456/u);
  assert.match(app.innerHTML, /class="tag blocked">OpenAI 封禁/u);
  assert.match(app.innerHTML, /class="tag error"[^>]*>temporary_failure/u);
  assert.doesNotMatch(app.innerHTML, /code_found/u);
});
