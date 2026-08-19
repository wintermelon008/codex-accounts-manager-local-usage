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
  assert.match(html, /下次刷新/u);
  assert.match(html, /3 秒轮询 \+ 0–1 秒随机偏移/u);
  assert.match(html, /shelf-chip\.selected::after/u);
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
  assert.equal(panel.confirmations.length, 0);
  assert.equal(panel.element("tingbai-start").textContent, "启动中…");
});

test("Tingbai waitlist omits both amount boundaries when the inputs are blank", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());

  panel.click("tingbaiStartWaitlist");

  const request = panel.posted.findLast((message) => message.action === "tingbaiStartWaitlist");
  assert.equal(Object.hasOwn(request, "minTotalFen"), false);
  assert.equal(Object.hasOwn(request, "maxTotalFen"), false);
  assert.equal(panel.confirmations.length, 0);
});

test("Tingbai waitlist displays checking and next-refresh countdown states", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        product: { code: "team-7d", name: "Team 7D", priceFen: 300, available: 0 },
        waitlist: { active: true, quantity: 1 },
        nextPollAt: Date.now() + 3_000,
        checking: false,
        records: []
      }
    }
  });

  assert.equal(panel.element("tingbai-waitlist-label").textContent, "候补运行中");
  assert.match(panel.element("tingbai-waitlist-countdown").textContent, /下次刷新 \d+\.\d 秒/u);
  assert.match(panel.element("tingbai-waitlist-progress").className, /active/u);

  panel.message({ type: "state", state: { tingbai: { waitlist: { active: true }, checking: true, records: [] } } });
  assert.equal(panel.element("tingbai-waitlist-label").textContent, "正在刷新库存…");
  assert.match(panel.element("tingbai-waitlist-progress").className, /checking/u);
});

test("Tingbai allows a new waitlist after a failed historical order", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        product: { code: "team-7d", name: "Team 7D", priceFen: 300, available: 0 },
        order: { orderId: "failed-order", state: "failed", imported: false },
        records: []
      }
    }
  });

  assert.equal(panel.element("tingbai-start").disabled, false);
  assert.equal(panel.element("tingbai-min-amount").disabled, false);
  assert.equal(panel.element("tingbai-max-amount").disabled, false);
});

test("Tingbai allows a new waitlist while a completed order awaits import", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        product: { code: "team-7d", name: "Team 7D", priceFen: 300, available: 0 },
        order: { orderId: "completed-order", state: "completed", imported: false, lastImportError: "导入暂时失败" },
        records: []
      }
    }
  });

  assert.equal(panel.element("tingbai-start").disabled, false);
  assert.equal(panel.element("tingbai-min-amount").disabled, false);
  assert.equal(panel.element("tingbai-max-amount").disabled, false);
});

test("Tingbai refresh errors remain separate from the inactive waitlist state", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        lastError: "超级炸弹车网络请求失败，请检查网络连接或服务是否可达",
        records: []
      }
    }
  });

  assert.equal(panel.element("tingbai-waitlist-label").textContent, "候补未启动");
  assert.doesNotMatch(panel.element("tingbai-waitlist-progress").className, /active|checking/u);
  assert.match(panel.element("tingbai-message").textContent, /候补未启动/u);
  assert.match(panel.element("tingbai-message").textContent, /最近一次同步或操作失败：超级炸弹车网络请求失败/u);
});

test("Tingbai start remains available when no product is currently listed", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());
  panel.message({
    type: "state",
    state: {
      tingbai: {
        credentialsConfigured: true,
        records: []
      }
    }
  });

  assert.equal(panel.element("tingbai-start").disabled, false);
});

test("Website buttons show progress and completion feedback", () => {
  const panel = runPanelScript(createBugTeamPanelHtml());

  panel.click("openWebsite");
  assert.equal(panel.element("open-website").textContent, "打开中…");
  panel.message({ type: "actionResult", action: "openWebsite", level: "success" });
  assert.equal(panel.element("open-website").textContent, "已打开 ✓");

  panel.click("tingbaiOpenWebsite");
  assert.equal(panel.element("tingbai-open-website").textContent, "打开中…");
  panel.message({ type: "actionResult", action: "tingbaiOpenWebsite", level: "error" });
  assert.equal(panel.element("tingbai-open-website").textContent, "打开失败");
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
    setInterval() { return 2; },
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
