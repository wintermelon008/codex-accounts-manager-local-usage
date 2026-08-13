"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
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
});
