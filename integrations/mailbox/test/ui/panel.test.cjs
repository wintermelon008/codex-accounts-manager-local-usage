"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createMailboxPanelHtml } = require("../../src/ui/panel.cjs");

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

test("Mailbox delete uses an in-panel confirmation before posting the delete action", () => {
  const html = createMailboxPanelHtml();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);

  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let insertedModal = "";
  const app = {};
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
