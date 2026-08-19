"use strict";

const crypto = require("node:crypto");

const BUGTEAM_PANEL_VIEW_TYPE = "codexAccounts.bugteam";

function createBugTeamPanelHtml() {
  const nonce = crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/gu, "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>BugTeam</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 93%, transparent);
      --soft: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
      --border: var(--vscode-editorWidget-border);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --button: var(--vscode-button-background);
      --button-text: var(--vscode-button-foreground);
      --danger: var(--vscode-errorForeground);
      --success: var(--vscode-testing-iconPassed);
      --warning: var(--vscode-editorWarning-foreground);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--text); background: var(--bg); font-family: var(--vscode-font-family); font-size: 13px; }
    button, input { font: inherit; color: inherit; }
    button { border: 1px solid var(--border); border-radius: 7px; background: var(--soft); padding: 8px 12px; cursor: pointer; transition: border-color .14s ease, color .14s ease, background .14s ease, transform .08s ease; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:active:not(:disabled) { transform: translateY(1px) scale(.99); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary { color: var(--button-text); background: var(--button); border-color: var(--button); }
    button.action-busy::before { content: ""; display: inline-block; width: 11px; height: 11px; margin-right: 7px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; vertical-align: -1px; animation: action-spin .7s linear infinite; }
    button.action-success { border-color: var(--success); color: var(--success); }
    button.action-error { border-color: var(--danger); color: var(--danger); }
    button:disabled { opacity: .48; cursor: default; }
    input { width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--vscode-input-background); }
    .shell { max-width: 920px; min-height: 100vh; margin: 0 auto; padding: 18px; }
    .topbar, .brand, .actions, .metric-row { display: flex; align-items: center; }
    .topbar { justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .brand { gap: 11px; min-width: 0; }
    .logo { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; color: var(--button-text); background: var(--button); font-weight: 800; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 23px; }
    h2 { font-size: 16px; }
    h3 { font-size: 14px; }
    .subtitle, .muted, .hint { color: var(--muted); }
    .subtitle { margin-top: 3px; }
    .actions { flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .notice { display: none; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 7px; white-space: pre-wrap; }
    .notice.visible { display: block; }
    .notice.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
    .notice.success { color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
    .source-card { margin-top: 16px; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
    .source-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border); }
    .source-head p { margin-top: 4px; }
    .source-block { padding: 16px; border-top: 1px solid var(--border); }
    .source-head + .source-block { border-top: 0; }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
    .section-head p { margin-top: 4px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
    .metric { min-width: 0; padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); }
    .metric-label { color: var(--muted); font-size: 11px; }
    .metric-value { display: block; margin-top: 5px; font-size: 17px; font-weight: 750; overflow-wrap: anywhere; }
    .metric-value.ok { color: var(--success); }
    .metric-value.warn { color: var(--warning); }
    .form-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
    .credentials-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .credentials-form .actions { grid-column: 1 / -1; }
    .amount-range-form { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }
    .field-label { display: block; margin-bottom: 6px; font-weight: 650; }
    .hint { margin-top: 7px; line-height: 1.45; font-size: 12px; }
    .product { padding: 13px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); }
    .product { margin-top: 12px; }
    .status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid currentColor; border-radius: 999px; color: var(--muted); white-space: nowrap; }
    .status.completed { color: var(--success); }
    .status.error { color: var(--danger); }
    .shelf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
    .shelf-chip { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; padding: 12px 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--soft); color: var(--text); text-align: left; }
    .shelf-chip:hover:not(:disabled), .shelf-chip.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--soft)); }
    .shelf-chip.selected::after { content: "已选择 ✓"; color: var(--success); font-weight: 750; }
    .shelf-chip.sold-out { opacity: .68; }
    .shelf-chip strong, .shelf-chip span { max-width: 100%; overflow-wrap: anywhere; }
    .shelf-chip strong { font-size: 14px; }
    .shelf-chip-counts, .shelf-chip-price { font-weight: 700; }
    .shelf-chip-price { color: var(--warning); }
    .shelf-chip .hint { margin-top: 2px; }
    .shelf-selection { margin-top: 11px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 7px; color: var(--muted); line-height: 1.45; }
    .shelf-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .shelf-actions button { min-width: 150px; }
    .toast { position: fixed; right: 20px; bottom: 20px; z-index: 10; max-width: min(380px, calc(100vw - 40px)); padding: 11px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-editorWidget-background); color: var(--text); box-shadow: 0 10px 28px rgba(0, 0, 0, .24); white-space: pre-wrap; }
    .toast.visible { display: block; }
    .toast.success { border-color: color-mix(in srgb, var(--success) 55%, var(--border)); color: var(--success); }
    .toast.error { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); color: var(--danger); }
    .empty { padding: 24px 10px; color: var(--muted); text-align: center; }
    .security { margin-top: 12px; color: var(--muted); line-height: 1.5; font-size: 12px; }
    .source-message { margin-top: 12px; color: var(--muted); line-height: 1.5; white-space: pre-wrap; }
    .source-message.error { color: var(--danger); }
    .waitlist-progress { display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); color: var(--muted); }
    .waitlist-progress.active { color: var(--success); border-color: color-mix(in srgb, var(--success) 42%, var(--border)); }
    .waitlist-progress.checking { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
    .waitlist-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: currentColor; opacity: .55; }
    .waitlist-progress.active .waitlist-dot, .waitlist-progress.checking .waitlist-dot { animation: waitlist-pulse 1.1s ease-in-out infinite; }
    .waitlist-progress strong { color: currentColor; }
    .waitlist-progress span:last-child { margin-left: auto; text-align: right; }
    .records { display: grid; gap: 9px; margin-top: 12px; }
    .record { padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); }
    .record-head { display: flex; justify-content: space-between; gap: 10px; }
    .record-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 9px; }
    .record-grid span { color: var(--muted); font-size: 11px; }
    .record-grid strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
    .account-balances { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 9px; }
    .account-balance { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); }
    .account-balance-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .account-balance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 10px; }
    .account-balance-grid span { color: var(--muted); font-size: 11px; }
    .account-balance-grid strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
    @keyframes action-spin { to { transform: rotate(360deg); } }
    @keyframes waitlist-pulse { 50% { opacity: 1; transform: scale(1.45); } }
    @media (max-width: 680px) { .topbar { display: block; } .topbar .actions { justify-content: flex-start; margin-top: 12px; } .metrics, .shelf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .form-row { grid-template-columns: 1fr; } .shelf-actions button { flex: 1 1 160px; } }
    @media (max-width: 420px) { .shelf-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><div class="logo">BT</div><div><h1>BugTeam 服务来源</h1><p class="subtitle">各来源独立购入，统一导入 Manager 无感池</p></div></div>
    </header>
    <div id="notice" class="notice" role="status"></div>
    <article class="source-card">
      <div class="source-head"><div><h2>BugTeam 官方 API</h2><p class="hint">API Token、1h 商品与服务端候补订单</p></div><div class="actions"><button id="open-website" type="button" data-action="openWebsite">打开网站</button><button id="refresh" type="button" data-action="refresh">刷新</button></div></div>
    <section class="source-block">
      <div class="section-head"><div><h2>API 连接</h2><p class="hint">Token 仅保存到本扩展的 SecretStorage，不会显示在页面状态中。</p></div><span id="connection-status" class="status">未配置</span></div>
      <form id="token-form" class="form-row">
        <label><span class="field-label">BugTeam API Token</span><input id="token" type="password" autocomplete="off" placeholder="粘贴 cfk_ Token"></label>
        <div class="actions"><button id="token-save" class="primary" type="submit">保存并连接</button><button id="clear-token" type="button" data-action="clearToken">清除本地 Token</button></div>
      </form>
      <p class="security">建议在 BugTeam API 页面创建长期 Token。扩展不会保存 BugTeam 密码，也不会把 Token 写入日志或 Manager 公共 API。</p>
    </section>
    <section class="source-block">
      <div class="section-head"><div><h2>当前发车</h2><p class="hint">显示当前货架档位；选中有库存的档位后可直接购买，也可以提交新鲜候补。</p></div><span id="shelf-status" class="status">未同步</span></div>
      <div id="shelves" class="shelf-grid"></div>
      <p id="shelf-selection" class="shelf-selection">未选档：可下新鲜候补订单（有多少发多少）</p>
      <div class="shelf-actions"><button id="shelf-purchase" class="primary" type="button" data-action="purchaseShelf">选择档位立即购买</button><button id="fresh-reserve" type="button" data-action="reserve">下候补订单</button></div>
    </section>
    <section class="source-block">
      <div class="section-head"><div><h2>账户与商品</h2><p class="hint">1h 商品由 BugTeam 商品目录动态识别，网页示例商品编码不会被硬编码。</p></div></div>
      <div id="metrics" class="metrics"></div>
      <div id="product" class="product"></div>
    </section>
    </article>
    <article class="source-card">
      <div class="source-head"><div><h2>超级炸弹车</h2><p class="hint">tingbai.top · 发现库存后自动余额购买并导入</p></div><div class="actions"><button id="tingbai-open-website" type="button" data-action="tingbaiOpenWebsite">打开网站</button><button id="tingbai-refresh" type="button" data-action="tingbaiRefresh">刷新</button></div></div>
      <section class="source-block">
        <div class="section-head"><div><h3>买家账户</h3><p class="hint">账号和密码仅保存到本扩展的 SecretStorage，用于候补期间恢复网页登录会话。</p></div><span id="tingbai-status" class="status">未配置</span></div>
        <form id="tingbai-credentials-form" class="form-row credentials-form">
          <label><span class="field-label">买家账号</span><input id="tingbai-username" type="text" autocomplete="username" maxlength="64" placeholder="输入买家账号"></label>
          <label><span class="field-label">密码</span><input id="tingbai-password" type="password" autocomplete="off" maxlength="128" placeholder="输入密码"></label>
          <div class="actions"><button id="tingbai-save" class="primary" type="submit">保存并验证</button><button id="tingbai-clear" type="button" data-action="tingbaiClearCredentials">清除凭据</button></div>
        </form>
      </section>
      <section class="source-block">
        <div class="section-head"><div><h3>库存候补</h3><p class="hint">候补固定购买 1 个；当前无货或目录暂时为空也可以启动，金额下限或上限可单独留空，两者都不填则不限制金额。</p></div></div>
        <div id="tingbai-metrics" class="metrics"></div>
        <div id="tingbai-product" class="product"></div>
        <div id="tingbai-waitlist-progress" class="waitlist-progress" role="status" aria-live="polite"><span class="waitlist-dot"></span><strong id="tingbai-waitlist-label">候补未启动</strong><span id="tingbai-waitlist-countdown">3 秒轮询 + 0–1 秒随机偏移</span></div>
        <div class="form-row amount-range-form">
          <label><span class="field-label">候补金额下限（元）</span><input id="tingbai-min-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="不限制"></label>
          <label><span class="field-label">候补金额上限（元）</span><input id="tingbai-max-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="不限制"></label>
        </div>
        <p id="tingbai-message" class="source-message"></p>
        <div class="shelf-actions"><button id="tingbai-start" class="primary" type="button" data-action="tingbaiStartWaitlist">开始候补</button><button id="tingbai-stop" type="button" data-action="tingbaiStopWaitlist">停止候补</button><button id="tingbai-retry-import" type="button" data-action="tingbaiRetryImport">重试导入</button></div>
      </section>
      <section class="source-block">
        <div class="section-head"><div><h3>购买记录</h3><p class="hint">记录自动下单时观测到的预计炸车时间与最终入池结果。</p></div></div>
        <div id="tingbai-records" class="records"></div>
      </section>
    </article>
    <article class="source-card">
      <div class="source-head"><div><h2>已购账号额度</h2><p class="hint">显示各来源最近导入账号的脱敏额度结果，不包含 Token。</p></div></div>
      <section class="source-block"><div id="account-balances" class="account-balances"></div></section>
    </article>
    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const appState = { tokenConfigured: false, balance: undefined, product: undefined, inventory: undefined, shelves: [], order: undefined, managerImportAvailable: false, lastError: undefined, tingbai: {} };
      const notice = document.getElementById("notice");
      const toast = document.getElementById("toast");
      const token = document.getElementById("token");
      const tokenSave = document.getElementById("token-save");
      const status = document.getElementById("connection-status");
      const openWebsite = document.getElementById("open-website");
      const refreshButton = document.getElementById("refresh");
      const metrics = document.getElementById("metrics");
      const product = document.getElementById("product");
      const shelves = document.getElementById("shelves");
      const shelfStatus = document.getElementById("shelf-status");
      const shelfSelection = document.getElementById("shelf-selection");
      const shelfPurchase = document.getElementById("shelf-purchase");
      const freshReserve = document.getElementById("fresh-reserve");
      const clearToken = document.getElementById("clear-token");
      const tingbaiUsername = document.getElementById("tingbai-username");
      const tingbaiPassword = document.getElementById("tingbai-password");
      const tingbaiSave = document.getElementById("tingbai-save");
      const tingbaiStatus = document.getElementById("tingbai-status");
      const tingbaiOpenWebsite = document.getElementById("tingbai-open-website");
      const tingbaiRefresh = document.getElementById("tingbai-refresh");
      const tingbaiClear = document.getElementById("tingbai-clear");
      const tingbaiMetrics = document.getElementById("tingbai-metrics");
      const tingbaiProduct = document.getElementById("tingbai-product");
      const tingbaiMinAmount = document.getElementById("tingbai-min-amount");
      const tingbaiMaxAmount = document.getElementById("tingbai-max-amount");
      const tingbaiMessage = document.getElementById("tingbai-message");
      const tingbaiWaitlistProgress = document.getElementById("tingbai-waitlist-progress");
      const tingbaiWaitlistLabel = document.getElementById("tingbai-waitlist-label");
      const tingbaiWaitlistCountdown = document.getElementById("tingbai-waitlist-countdown");
      const tingbaiStart = document.getElementById("tingbai-start");
      const tingbaiStop = document.getElementById("tingbai-stop");
      const tingbaiRetryImport = document.getElementById("tingbai-retry-import");
      const tingbaiRecords = document.getElementById("tingbai-records");
      const accountBalances = document.getElementById("account-balances");
      let busy = false;
      let activeAction = "";
      let feedbackAction = "";
      let feedbackLevel = "";
      let selectedShelfBucketStart = "";
      let toastTimer;
      let feedbackTimer;

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "state") {
          Object.assign(appState, message.state || {});
          renderSafely();
        } else if (message.type === "toast") {
          showToast(message.message, message.level);
        } else if (message.type === "actionResult") {
          finishAction(message.action, message.level);
        }
      });

      document.addEventListener("click", (event) => {
        const target = event.target?.closest?.("[data-action]");
        if (!target || target.disabled) return;
        const action = target.dataset.action;
        if (action === "selectShelf") { selectedShelfBucketStart = target.dataset.bucketStart || ""; renderSafely(); }
        else if (action === "purchaseShelf") { beginAction("purchaseShelf"); send("purchaseShelf", { bucketStart: selectedShelfBucketStart }); }
        else if (action === "purchase" || action === "reserve") { beginAction("reserve"); send("reserve"); }
        else if (action === "refresh") { beginAction("refresh"); send("refresh"); }
        else if (action === "openWebsite") { beginAction(action); send(action); }
        else if (action === "clearToken") {
          if (window.confirm("清除本地 BugTeam Token？进行中的订单需要先完成或确认。")) { beginAction("clearToken"); send("clearToken"); }
        }
        else if (action === "retryImport") { beginAction("retryImport"); send("retryImport"); }
        else if (action === "tingbaiRefresh") { beginAction(action); send(action); }
        else if (action === "tingbaiOpenWebsite") { beginAction(action); send(action); }
        else if (action === "tingbaiClearCredentials") {
          if (window.confirm("清除超级炸弹车买家凭据？")) { beginAction(action); send(action); }
        }
        else if (action === "tingbaiStartWaitlist") {
          const minTotalFen = readAmountFen(tingbaiMinAmount, "候补金额下限");
          const maxTotalFen = readAmountFen(tingbaiMaxAmount, "候补金额上限");
          if (minTotalFen === null || maxTotalFen === null) { finishAction(action, "error"); return; }
          if (minTotalFen !== undefined && maxTotalFen !== undefined && minTotalFen > maxTotalFen) {
            showNotice("候补金额下限不能大于上限", "error");
            finishAction(action, "error");
            return;
          }
          const payload = {};
          if (minTotalFen !== undefined) payload.minTotalFen = minTotalFen;
          if (maxTotalFen !== undefined) payload.maxTotalFen = maxTotalFen;
          beginAction(action);
          send(action, payload);
        }
        else if (action === "tingbaiStopWaitlist" || action === "tingbaiRetryImport") { beginAction(action); send(action); }
      });

      document.getElementById("token-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const value = token.value.trim();
        if (!value) { showNotice("请先粘贴 BugTeam API Token", "error"); finishAction("setToken", "error"); return; }
        beginAction("setToken");
        token.value = "";
        send("setToken", { token: value });
      });

      document.getElementById("tingbai-credentials-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const username = tingbaiUsername.value.trim();
        const password = tingbaiPassword.value;
        if (!username || !password) { showNotice("请输入超级炸弹车买家账号和密码", "error"); finishAction("tingbaiSetCredentials", "error"); return; }
        beginAction("tingbaiSetCredentials");
        tingbaiPassword.value = "";
        send("tingbaiSetCredentials", { username, password });
      });

      function render() {
        status.textContent = appState.tokenConfigured ? (appState.lastError ? "异常" : "已连接") : "未配置";
        status.className = "status " + (appState.lastError ? "error" : appState.tokenConfigured ? "completed" : "");
        const balance = appState.balance;
        const inv = appState.inventory;
        const retryingUncertainOrder = Boolean(appState.order && (appState.order.uncertain || appState.order.state === 'uncertain'));
        const orderBlocksPurchase = Boolean(appState.order && !retryingUncertainOrder && appState.order.orderId && appState.order.state !== 'cancelled' && !(appState.order.state === 'completed' && appState.order.imported));
        const canCreateOrder = appState.tokenConfigured && Boolean(appState.product) && !orderBlocksPurchase;
        metrics.innerHTML = [
          metric("可用余额", balance ? money(balance.availableFen) : "—", balance && balance.availableFen > 0 ? "ok" : ""),
          metric("账户余额", balance ? money(balance.balanceFen) : "—", ""),
          metric("订单冻结", balance ? money(balance.heldFen) : "—", ""),
          metric("可交付库存", inv ? String(inv.available) + " 个" : "—", inv && inv.available > 0 ? "ok" : "")
        ].join("");
        product.innerHTML = appState.product ? '<strong>' + esc(appState.product.name) + '</strong><div class="hint">商品编码：' + esc(appState.product.code) + ' · 基准有效期：' + duration(appState.product.billingBaseSeconds) + ' · 基准价：' + money(appState.product.priceFen) + '</div>' + (inv ? '<div class="hint">本次报价锁款：' + money(inv.hold_total_fen) + ' · 预计总额：' + money(inv.estimated_total_fen) + '</div>' : '') : '<div class="empty">连接后读取 1h 商品目录。</div>';
        renderShelves();
        openWebsite.disabled = busy;
        refreshButton.disabled = busy;
        const selectedShelf = (Array.isArray(appState.shelves) ? appState.shelves : []).find((shelf) => shelf.bucketStart === selectedShelfBucketStart && shelf.available > 0);
        shelfPurchase.disabled = busy || !canCreateOrder || !selectedShelf || retryingUncertainOrder;
        freshReserve.disabled = busy || !canCreateOrder;
        clearToken.disabled = busy || !appState.tokenConfigured;
        tokenSave.disabled = busy;
        renderTingbai();
        renderAccountBalances();
        setActionButton(openWebsite, "openWebsite", "打开网站", "打开中…", "已打开 ✓", "打开失败");
        setActionButton(tokenSave, "setToken", "保存并连接", "连接中…", "连接成功 ✓", "连接失败");
        setActionButton(refreshButton, "refresh", "刷新", "同步中…", "已同步 ✓", "同步失败");
        setActionButton(shelfPurchase, "purchaseShelf", "选择档位立即购买", "购买中…", "已提交 ✓", "购买失败");
        setActionButton(freshReserve, "reserve", "下候补订单", "候补中…", "已提交 ✓", "提交失败");
        setActionButton(clearToken, "clearToken", "清除本地 Token", "清除中…", "已清除 ✓", "清除失败");
      }

      function renderTingbai() {
        const source = appState.tingbai || {};
        const configured = source.credentialsConfigured === true;
        const waitlist = source.waitlist;
        const order = source.order;
        const orderBlocksWaitlist = Boolean(order && !order.imported && !isFailedOrderState(order.state) && !isCompletedOrderState(order.state));
        const productState = source.product;
        const balance = source.balance;
        tingbaiStatus.textContent = source.lastError ? "异常" : waitlist?.active ? "候补中" : configured ? "已连接" : "未配置";
        tingbaiStatus.className = "status " + (source.lastError ? "error" : configured ? "completed" : "");
        if (configured && !tingbaiUsername.value) tingbaiUsername.value = source.username || "";
        tingbaiMetrics.innerHTML = [
          metric("账户余额", balance ? money(balance.balanceFen) : "—", balance && balance.balanceFen > 0 ? "ok" : ""),
          metric("当前库存", productState ? String(number(productState.available)) + " 个" : "—", productState && productState.available > 0 ? "ok" : ""),
          metric("当前售价", productState ? money(productState.priceFen) : "—", ""),
          metric("预计炸车时间", productState?.estimatedExplosionAt ? formatDateTime(productState.estimatedExplosionAt) : "—", "")
        ].join("");
        tingbaiProduct.innerHTML = productState
          ? '<strong>' + esc(productState.name) + '</strong><div class="hint">商品编码：' + esc(productState.code) + ' · 最近检查：' + esc(formatDateTime(source.checkedAt)) + '</div>'
          : '<div class="empty">刷新后读取公开商品目录。</div>';
        renderTingbaiWaitlistStatus();
        const lines = [];
        if (waitlist?.active) lines.push('候补运行中：有货后购买 ' + number(waitlist.quantity) + ' 个，实时总价需满足 ' + amountRange(waitlist.minTotalFen, waitlist.maxTotalFen));
        else if (source.attemptPending) lines.push('订单请求结果待确认，将复用同一请求继续查询。');
        else if (order && !order.imported) lines.push('订单 ' + (order.orderId || '处理中') + ' · ' + orderState(order.state));
        else lines.push('候补未启动。');
        if (source.lastError) lines.push('最近一次同步或操作失败：' + source.lastError);
        tingbaiMessage.textContent = lines.join('\\n');
        tingbaiMessage.className = 'source-message' + (source.lastError ? ' error' : '');
        tingbaiSave.disabled = busy;
        tingbaiOpenWebsite.disabled = busy;
        tingbaiRefresh.disabled = busy;
        tingbaiClear.disabled = busy || !configured;
        const amountRangeLocked = busy || waitlist?.active || source.attemptPending || orderBlocksWaitlist;
        if (waitlist?.active) {
          tingbaiMinAmount.value = amountInput(waitlist.minTotalFen);
          tingbaiMaxAmount.value = amountInput(waitlist.maxTotalFen);
        }
        tingbaiMinAmount.disabled = amountRangeLocked;
        tingbaiMaxAmount.disabled = amountRangeLocked;
        tingbaiStart.disabled = busy || !configured || waitlist?.active || source.attemptPending || orderBlocksWaitlist;
        tingbaiStop.disabled = busy || !waitlist?.active || source.attemptPending;
        tingbaiRetryImport.hidden = !order?.lastImportError;
        tingbaiRetryImport.disabled = busy;
        const records = Array.isArray(source.records) ? source.records : [];
        tingbaiRecords.innerHTML = records.length ? records.map((record) => '<article class="record"><div class="record-head"><strong>订单 ' + esc(record.orderId) + '</strong><span class="status ' + (record.imported ? 'completed' : '') + '">' + esc(record.imported ? importResultLabel(record.importResult) : orderState(record.state)) + '</span></div><div class="record-grid"><div><span>预计炸车时间</span><strong>' + esc(formatDateTime(record.estimatedExplosionAt)) + '</strong></div><div><span>检测到库存</span><strong>' + esc(formatDateTime(record.detectedAt)) + '</strong></div><div><span>成交金额</span><strong>' + esc(money(record.amountFen)) + '</strong></div></div></article>').join('') : '<div class="empty">暂无自动购买记录。</div>';
        setActionButton(tingbaiOpenWebsite, 'tingbaiOpenWebsite', '打开网站', '打开中…', '已打开 ✓', '打开失败');
        setActionButton(tingbaiSave, 'tingbaiSetCredentials', '保存并验证', '验证中…', '验证成功 ✓', '验证失败');
        setActionButton(tingbaiRefresh, 'tingbaiRefresh', '刷新', '同步中…', '已同步 ✓', '同步失败');
        setActionButton(tingbaiClear, 'tingbaiClearCredentials', '清除凭据', '清除中…', '已清除 ✓', '清除失败');
        setActionButton(tingbaiStart, 'tingbaiStartWaitlist', '开始候补', '启动中…', '已启动 ✓', '启动失败');
        setActionButton(tingbaiStop, 'tingbaiStopWaitlist', '停止候补', '停止中…', '已停止 ✓', '停止失败');
        setActionButton(tingbaiRetryImport, 'tingbaiRetryImport', '重试导入', '导入中…', '导入成功 ✓', '导入失败');
      }

      function renderTingbaiWaitlistStatus() {
        const source = appState.tingbai || {};
        const active = source.waitlist?.active === true;
        const checking = active && source.checking === true;
        tingbaiWaitlistProgress.className = 'waitlist-progress' + (checking ? ' checking' : active ? ' active' : '');
        tingbaiWaitlistLabel.textContent = checking ? '正在刷新库存…' : active ? '候补运行中' : '候补未启动';
        if (!active) {
          tingbaiWaitlistCountdown.textContent = '3 秒轮询 + 0–1 秒随机偏移';
          return;
        }
        if (checking) {
          tingbaiWaitlistCountdown.textContent = '正在读取目录并核对报价';
          return;
        }
        const remainingMs = Math.max(0, Number(source.nextPollAt) - Date.now());
        tingbaiWaitlistCountdown.textContent = Number.isFinite(remainingMs) && source.nextPollAt
          ? '下次刷新 ' + (remainingMs / 1000).toFixed(1) + ' 秒'
          : '等待下一轮刷新';
      }

      function renderAccountBalances() {
        const items = [];
        const append = (accounts) => {
          for (const account of Array.isArray(accounts) ? accounts : []) {
            if (account && typeof account === 'object') items.push(account);
          }
        };
        append(appState.order?.importResult?.accounts);
        for (const record of Array.isArray(appState.tingbai?.records) ? appState.tingbai.records : []) {
          append(record?.importResult?.accounts);
        }
        const unique = [];
        const seen = new Set();
        for (const account of items) {
          const key = String(account.accountId || account.email || '');
          if (!key || seen.has(key)) continue;
          seen.add(key);
          unique.push(account);
        }
        accountBalances.innerHTML = unique.length
          ? unique.map((account) => '<article class="account-balance"><div class="account-balance-head"><div><strong>' + esc(account.email || account.accountId || '未知账号') + '</strong><div class="hint">' + esc(account.planType || '未知套餐') + '</div></div><span class="status ' + (account.poolEnabled || account.status === 'already_exists' ? 'completed' : 'error') + '">' + esc(account.poolEnabled ? '已入无感池' : accountResultState(account.status)) + '</span></div><div class="account-balance-grid"><div><span>5h 额度</span><strong>' + esc(percentage(account.hourlyPercentage)) + '</strong></div><div><span>周额度</span><strong>' + esc(percentage(account.weeklyPercentage)) + '</strong></div><div><span>Credits 余额</span><strong>' + esc(account.creditsBalance || '—') + '</strong></div></div></article>').join('')
          : '<div class="empty">购买并完成额度刷新后显示每个账号的额度。</div>';
      }

      function renderShelves() {
        const items = Array.isArray(appState.shelves) ? appState.shelves : [];
        shelfStatus.textContent = appState.tokenConfigured ? (appState.lastError ? "异常" : "已同步") : "未同步";
        shelfStatus.className = "status " + (appState.lastError ? "error" : appState.tokenConfigured ? "completed" : "");
        const selected = items.find((shelf) => shelf.bucketStart === selectedShelfBucketStart && shelf.available > 0);
        if (!selected) selectedShelfBucketStart = "";
        if (!appState.tokenConfigured || !appState.product) {
          shelves.innerHTML = '<div class="empty">连接后读取当前发车档位。</div>';
          shelfSelection.textContent = "未选档：可下新鲜候补订单（有多少发多少）";
          return;
        }
        if (!items.length) {
          shelves.innerHTML = '<div class="empty">当前没有可展示的发车档位。</div>';
          shelfSelection.textContent = "未选档：可下新鲜候补订单（有多少发多少）";
          return;
        }
        shelves.innerHTML = items.map((shelf) => {
          const available = number(shelf.available);
          const selectedClass = shelf.bucketStart === selectedShelfBucketStart ? " selected" : "";
          const soldClass = available > 0 ? "" : " sold-out";
          return '<button type="button" class="shelf-chip' + selectedClass + soldClass + '" data-action="selectShelf" data-bucket-start="' + esc(shelf.bucketStart) + '"' + (available > 0 ? "" : " disabled") + '><strong>发车时间 ' + esc(formatDeparture(shelf.departureAt || shelf.bucketStart)) + '</strong><span class="shelf-chip-counts">未售：' + esc(String(available)) + ' · 已售：' + esc(String(number(shelf.sold))) + '</span><span class="shelf-chip-price">' + esc(shelfPrice(shelf)) + '</span><span class="hint">' + esc(shelfAvailability(shelf)) + '</span></button>';
        }).join("");
        if (!selectedShelfBucketStart) {
          shelfSelection.textContent = "未选档：可下新鲜候补订单（有多少发多少）";
          return;
        }
        const current = items.find((shelf) => shelf.bucketStart === selectedShelfBucketStart);
        shelfSelection.textContent = current
          ? '已选档 发车时间 ' + formatDeparture(current.departureAt || current.bucketStart) + '（未售 ' + number(current.available) + ' · 已售 ' + number(current.sold) + ' · ' + shelfPrice(current) + '）'
          : "未选档：可下新鲜候补订单（有多少发多少）";
      }

      function metric(label, value, tone) { return '<div class="metric"><span class="metric-label">' + esc(label) + '</span><strong class="metric-value ' + tone + '">' + esc(value) + '</strong></div>'; }
      function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0; }
      function shelfPrice(shelf) {
        if (number(shelf.available) < 1 || !appState.product) return '当前单价 —';
        const base = number(appState.product.priceFen);
        if (!base) return '当前单价 —';
        const minimum = number(shelf.minimumRemainingSeconds);
        const maximum = number(shelf.maximumRemainingSeconds);
        const charge = (seconds) => seconds >= 1800 ? base : Math.round(base * 2 / 3);
        const low = charge(Math.min(minimum, maximum));
        const high = charge(Math.max(minimum, maximum));
        return low === high ? '当前单价 ' + money(low) : '当前单价 ' + money(Math.min(low, high)) + ' – ' + money(Math.max(low, high));
      }
      function shelfAvailability(shelf) {
        if (number(shelf.available) < 1) return '已售罄';
        const minimum = number(shelf.minimumRemainingSeconds);
        const maximum = number(shelf.maximumRemainingSeconds);
        if (!maximum) return '当前可售';
        const lower = duration(minimum);
        const upper = duration(maximum);
        return lower === upper ? '剩余约 ' + lower : '剩余约 ' + lower + ' – ' + upper;
      }
      function formatDeparture(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value || '—');
        const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
        const part = (type) => parts.find((item) => item.type === type)?.value || '';
        return part('month') + '/' + part('day') + ' ' + part('hour') + ':' + part('minute');
      }
      function formatDateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
      }
      function orderState(value) { return ({ completed: '已完成', delivered: '已完成', failed: '失败', refunded: '已退款', processing: '处理中', fulfilling: '发货中', waiting_inventory: '等待库存' }[String(value || '').toLowerCase()] || String(value || '处理中')); }
      function isCompletedOrderState(value) { return ['completed', 'complete', 'fulfilled', 'delivered', 'success'].includes(String(value || '').toLowerCase()); }
      function isFailedOrderState(value) { return ['cancelled', 'canceled', 'expired', 'failed', 'refunded', 'fulfillment_error'].includes(String(value || '').toLowerCase()); }
      function accountResultState(value) { return ({ already_exists: '已存在，已跳过导入', refresh_failed: '额度刷新失败', not_eligible: '暂无额度能力', import_failed: '导入失败' }[String(value || '').toLowerCase()] || '未入无感池'); }
      function importResultLabel(result) {
        const total = number(result?.total);
        const skipped = number(result?.skippedExisting);
        return skipped >= total && total > 0 ? '已存在，已跳过导入' : number(result?.poolEnabled) + skipped >= total ? '已入池' : '已导入';
      }
      function percentage(value) { const parsed = Number(value); return value !== null && value !== undefined && Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) + '%' : '—'; }
      function duration(seconds) { const value = Number(seconds); if (!Number.isFinite(value)) return '—'; if (value % 3600 === 0) return (value / 3600) + ' 小时'; if (value % 60 === 0) return (value / 60) + ' 分钟'; return Math.round(value) + ' 秒'; }
      function money(fen) { const value = Number(fen); return Number.isFinite(value) ? '¥' + (value / 100).toFixed(2) : '—'; }
      function amountInput(fen) { const value = optionalFen(fen); return value === undefined ? '' : (value / 100).toFixed(2); }
      function amountRange(minValue, maxValue) {
        const minimum = optionalFen(minValue);
        const maximum = optionalFen(maxValue);
        if (minimum !== undefined && maximum !== undefined) return '>= ' + money(minimum) + ' 且 <= ' + money(maximum);
        if (minimum !== undefined) return '>= ' + money(minimum);
        if (maximum !== undefined) return '<= ' + money(maximum);
        return '不限制金额';
      }
      function optionalFen(value) {
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
      }
      function readAmountFen(input, label) {
        const raw = String(input.value || '').trim();
        if (!raw) return undefined;
        const yuan = Number(raw);
        const fen = Math.round(yuan * 100);
        if (!Number.isFinite(yuan) || yuan < 0 || !Number.isSafeInteger(fen) || Math.abs(yuan * 100 - fen) > 0.000001) {
          showNotice(label + '请输入不超过两位小数的非负金额', 'error');
          return null;
        }
        return fen;
      }
      function esc(value) { return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
      function send(action, payload = {}) { vscode.postMessage({ type: 'bugteam:action', action, ...payload }); }
      function beginAction(action) {
        window.clearTimeout(feedbackTimer);
        busy = true;
        activeAction = action;
        feedbackAction = '';
        feedbackLevel = '';
        renderSafely();
      }
      function finishAction(action, level) {
        busy = false;
        activeAction = '';
        feedbackAction = String(action || '');
        feedbackLevel = level === 'error' ? 'error' : 'success';
        renderSafely();
        window.clearTimeout(feedbackTimer);
        feedbackTimer = window.setTimeout(() => {
          feedbackAction = '';
          feedbackLevel = '';
          renderSafely();
        }, 1_800);
      }
      function setActionButton(button, action, idleLabel, busyLabel, successLabel, errorLabel) {
        const running = busy && activeAction === action;
        const completed = !running && feedbackAction === action;
        button.classList.toggle('action-busy', running);
        button.classList.toggle('action-success', completed && feedbackLevel === 'success');
        button.classList.toggle('action-error', completed && feedbackLevel === 'error');
        button.setAttribute('aria-busy', running ? 'true' : 'false');
        button.textContent = running ? busyLabel : completed ? (feedbackLevel === 'error' ? errorLabel : successLabel) : idleLabel;
      }
      function renderSafely() {
        try {
          render();
        } catch (error) {
          busy = false;
          activeAction = '';
          const detail = error instanceof Error && error.message ? '：' + error.message.slice(0, 160) : '';
          showNotice('BugTeam 面板重绘失败，请重新打开面板' + detail, 'error');
        }
      }
      function showNotice(message, level) { notice.textContent = message || ''; notice.className = 'notice visible ' + (level || ''); }
      function showToast(message, level) {
        window.clearTimeout(toastTimer);
        toast.textContent = message || '';
        toast.hidden = !message;
        toast.className = 'toast visible ' + (level || 'info');
        if (message) toastTimer = window.setTimeout(() => { toast.hidden = true; toast.className = 'toast'; }, 4_500);
      }
      renderSafely();
      window.setInterval(() => renderTingbaiWaitlistStatus(), 250);
      send('ready');
    })();
  </script>
</body>
</html>`;
}

module.exports = { BUGTEAM_PANEL_VIEW_TYPE, createBugTeamPanelHtml };
