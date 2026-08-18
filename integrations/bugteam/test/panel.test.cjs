"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
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
  assert.match(html, /超级炸弹车/u);
  assert.match(html, /tingbai\.top/u);
  assert.match(html, /data-action="tingbaiStartWaitlist"/u);
  assert.match(html, /预计炸车时间/u);
  assert.match(html, /购买记录/u);
  assert.match(html, /候补金额下限/u);
  assert.match(html, /候补金额上限/u);
  assert.match(html, /两者都不填则不限制金额/u);
  assert.match(html, />= /u);
  assert.match(html, /<= /u);
  assert.match(html, /acquireVsCodeApi/u);
  assert.match(html, /id="account-balances"/u);
  assert.match(html, /actionResult/u);
  assert.match(html, /action-busy/u);
  assert.doesNotMatch(html, /id="order"/u);
  assert.doesNotMatch(html, /data-action="purchase"/u);
  assert.doesNotMatch(html, /Manager 导入/u);
  assert.doesNotMatch(html, /X-Customer-Token/u);
});

test("Tingbai credential submission survives intermediate state renders and shows button feedback", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.element("tingbai-username").value = "buyer-one";
  panel.element("tingbai-password").value = "password-one";

  panel.submit("tingbai-credentials-form");
  assert.equal(panel.element("tingbai-save").textContent, "验证中…");
  assert.match(panel.element("tingbai-save").className, /action-busy/u);

  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        username: "buyer-one",
        balance: { balanceFen: 900 },
        product: { code: "team-7d", name: "Team 7D", priceFen: 300, available: 0 },
        records: []
      }
    }
  });
  assert.equal(panel.element("tingbai-save").textContent, "验证中…");

  panel.message({ type: "actionResult", action: "tingbaiSetCredentials", level: "success" });
  assert.equal(panel.element("tingbai-save").textContent, "验证成功 ✓");
  assert.match(panel.element("tingbai-save").className, /action-success/u);
  assert.doesNotMatch(panel.element("notice").textContent, /重绘失败/u);
});

test("Tingbai waitlist sends optional inclusive amount boundaries in fen", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.element("tingbai-min-amount").value = "3.25";
  panel.element("tingbai-max-amount").value = "4.50";

  panel.click("tingbaiStartWaitlist");

  const request = panel.posted.findLast((message) => message.action === "tingbaiStartWaitlist");
  assert.equal(request.minTotalFen, 325);
  assert.equal(request.maxTotalFen, 450);
  assert.match(panel.confirmations[0], />= ¥3\.25 且 <= ¥4\.50/u);
  assert.equal(panel.element("tingbai-start").textContent, "启动中…");
});

test("Tingbai waitlist omits both amount boundaries when the inputs are blank", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());

  panel.click("tingbaiStartWaitlist");

  const request = panel.posted.findLast((message) => message.action === "tingbaiStartWaitlist");
  assert.equal(Object.hasOwn(request, "minTotalFen"), false);
  assert.equal(Object.hasOwn(request, "maxTotalFen"), false);
  assert.match(panel.confirmations[0], /不限制金额/u);
});

test("BugTeam panel renders each imported account quota without credentials", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      order: {
        importResult: {
          accounts: [{
            accountId: "account-one",
            email: "one@example.test",
            planType: "team",
            hourlyPercentage: 82,
            weeklyPercentage: 94,
            creditsBalance: "12.50",
            poolEnabled: true,
            status: "ready"
          }]
        }
      }
    }
  });

  const html = panel.element("account-balances").innerHTML;
  assert.match(html, /one@example\.test/u);
  assert.match(html, /82%/u);
  assert.match(html, /94%/u);
  assert.match(html, /12\.50/u);
  assert.doesNotMatch(html, /access.token|id.token/iu);
});

function runPanelScript(html) {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script, "panel script should exist");
  const elements = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/gu)) elements.set(match[1], createElement());
  const windowListeners = new Map();
  const documentListeners = new Map();
  const posted = [];
  const confirmations = [];
  const windowObject = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    clearTimeout() {},
    setTimeout() { return 1; },
    confirm(message) { confirmations.push(message); return true; }
  };
  const documentObject = {
    getElementById(id) { return elements.get(id); },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage(message) { posted.push(message); } }),
    document: documentObject,
    window: windowObject,
    console
  });
  return {
    element(id) { return elements.get(id); },
    click(action) {
      const target = { disabled: false, dataset: { action } };
      target.closest = () => target;
      documentListeners.get("click")?.({ target });
    },
    message(data) { windowListeners.get("message")?.({ data }); },
    submit(id) { elements.get(id).emit("submit", { preventDefault() {} }); },
    posted,
    confirmations
  };
}

function createElement() {
  const listeners = new Map();
  const element = {
    value: "",
    textContent: "",
    className: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    emit(type, event) { listeners.get(type)?.(event); },
    setAttribute() {}
  };
  element.classList = {
    toggle(name, enabled) {
      const classes = new Set(element.className.split(/\s+/u).filter(Boolean));
      if (enabled) classes.add(name);
      else classes.delete(name);
      element.className = [...classes].join(" ");
    }
  };
  return element;
}
