"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createBugTeamPanelHtml } = require("../src/ui/panel.cjs");

test("BugTeam panel exposes token, balance, dispatch shelf actions, and refresh feedback", () => {
  const html = createBugTeamPanelHtml();
  assert.match(html, /BugTeam API Token/u);
  assert.match(html, /当前发车/u);
  assert.match(html, /选择档位立即购买/u);
  assert.match(html, /下候补订单/u);
  assert.match(html, /同步中…/u);
  assert.match(html, /data-action="purchaseShelf"/u);
  assert.match(html, /data-action="reserve"/u);
  assert.match(html, /id="toast"/u);
  assert.match(html, /billingBaseSeconds/u);
  assert.match(html, /清除本地 Token/u);
  assert.match(html, /data-action="openWebsite"/u);
  assert.match(html, /acquireVsCodeApi/u);
  assert.doesNotMatch(html, /id="order"/u);
  assert.doesNotMatch(html, /data-action="purchase"/u);
  assert.doesNotMatch(html, /Manager 导入/u);
  assert.doesNotMatch(html, /X-Customer-Token/u);
});
