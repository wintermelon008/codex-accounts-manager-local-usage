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
    button { border: 1px solid var(--border); border-radius: 7px; background: var(--soft); padding: 8px 12px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary { color: var(--button-text); background: var(--button); border-color: var(--button); }
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
    .section { margin-top: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
    .section-head p { margin-top: 4px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
    .metric { min-width: 0; padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); }
    .metric-label { color: var(--muted); font-size: 11px; }
    .metric-value { display: block; margin-top: 5px; font-size: 17px; font-weight: 750; overflow-wrap: anywhere; }
    .metric-value.ok { color: var(--success); }
    .metric-value.warn { color: var(--warning); }
    .form-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
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
    @media (max-width: 680px) { .topbar { display: block; } .topbar .actions { justify-content: flex-start; margin-top: 12px; } .metrics, .shelf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .form-row { grid-template-columns: 1fr; } .shelf-actions button { flex: 1 1 160px; } }
    @media (max-width: 420px) { .shelf-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><div class="logo">BT</div><div><h1>BugTeam</h1><p class="subtitle">余额、1h 商品与候补订单</p></div></div>
      <div class="actions"><button type="button" data-action="openWebsite">打开 BugTeam 网页</button><button id="refresh" type="button" data-action="refresh">刷新</button></div>
    </header>
    <div id="notice" class="notice" role="status"></div>
    <section class="section">
      <div class="section-head"><div><h2>API 连接</h2><p class="hint">Token 仅保存到本扩展的 SecretStorage，不会显示在页面状态中。</p></div><span id="connection-status" class="status">未配置</span></div>
      <form id="token-form" class="form-row">
        <label><span class="field-label">BugTeam API Token</span><input id="token" type="password" autocomplete="off" placeholder="粘贴 cfk_ Token"></label>
        <div class="actions"><button class="primary" type="submit">保存并连接</button><button id="clear-token" type="button" data-action="clearToken">清除本地 Token</button></div>
      </form>
      <p class="security">建议在 BugTeam API 页面创建长期 Token。扩展不会保存 BugTeam 密码，也不会把 Token 写入日志或 Manager 公共 API。</p>
    </section>
    <section class="section">
      <div class="section-head"><div><h2>当前发车</h2><p class="hint">显示当前货架档位；选中有库存的档位后可直接购买，也可以提交新鲜候补。</p></div><span id="shelf-status" class="status">未同步</span></div>
      <div id="shelves" class="shelf-grid"></div>
      <p id="shelf-selection" class="shelf-selection">未选档：可下新鲜候补订单（有多少发多少）</p>
      <div class="shelf-actions"><button id="shelf-purchase" class="primary" type="button" data-action="purchaseShelf">选择档位立即购买</button><button id="fresh-reserve" type="button" data-action="reserve">下候补订单</button></div>
    </section>
    <section class="section">
      <div class="section-head"><div><h2>账户与商品</h2><p class="hint">1h 商品由 BugTeam 商品目录动态识别，网页示例商品编码不会被硬编码。</p></div></div>
      <div id="metrics" class="metrics"></div>
      <div id="product" class="product"></div>
    </section>
    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const appState = { tokenConfigured: false, balance: undefined, product: undefined, inventory: undefined, shelves: [], order: undefined, managerImportAvailable: false, lastError: undefined };
      const notice = document.getElementById("notice");
      const toast = document.getElementById("toast");
      const token = document.getElementById("token");
      const status = document.getElementById("connection-status");
      const refreshButton = document.getElementById("refresh");
      const metrics = document.getElementById("metrics");
      const product = document.getElementById("product");
      const shelves = document.getElementById("shelves");
      const shelfStatus = document.getElementById("shelf-status");
      const shelfSelection = document.getElementById("shelf-selection");
      const shelfPurchase = document.getElementById("shelf-purchase");
      const freshReserve = document.getElementById("fresh-reserve");
      const clearToken = document.getElementById("clear-token");
      let busy = false;
      let activeAction = "";
      let selectedShelfBucketStart = "";
      let toastTimer;

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "state") {
          Object.assign(appState, message.state || {});
          busy = false;
          activeAction = "";
          render();
        } else if (message.type === "toast") {
          busy = false;
          activeAction = "";
          showToast(message.message, message.level);
          render();
        }
      });

      document.addEventListener("click", (event) => {
        const target = event.target?.closest?.("[data-action]");
        if (!target || target.disabled) return;
        const action = target.dataset.action;
        if (action === "selectShelf") { selectedShelfBucketStart = target.dataset.bucketStart || ""; render(); }
        else if (action === "purchaseShelf") { busy = true; activeAction = "purchaseShelf"; render(); send("purchaseShelf", { bucketStart: selectedShelfBucketStart }); }
        else if (action === "purchase" || action === "reserve") { busy = true; activeAction = "reserve"; render(); send("reserve"); }
        else if (action === "refresh") { busy = true; activeAction = "refresh"; render(); send("refresh"); }
        else if (action === "openWebsite") send("openWebsite");
        else if (action === "clearToken") {
          if (window.confirm("清除本地 BugTeam Token？进行中的订单需要先完成或确认。")) { busy = true; activeAction = "clearToken"; render(); send("clearToken"); }
        }
        else if (action === "retryImport") { busy = true; activeAction = "retryImport"; render(); send("retryImport"); }
      });

      document.getElementById("token-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const value = token.value.trim();
        if (!value) { showNotice("请先粘贴 BugTeam API Token", "error"); return; }
        busy = true;
        activeAction = "setToken";
        token.value = "";
        render();
        send("setToken", { token: value });
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
        refreshButton.disabled = busy;
        refreshButton.textContent = activeAction === "refresh" ? "同步中…" : "刷新";
        const selectedShelf = (Array.isArray(appState.shelves) ? appState.shelves : []).find((shelf) => shelf.bucketStart === selectedShelfBucketStart && shelf.available > 0);
        shelfPurchase.disabled = busy || !canCreateOrder || !selectedShelf || retryingUncertainOrder;
        shelfPurchase.textContent = activeAction === "purchaseShelf" ? "购买中…" : "选择档位立即购买";
        freshReserve.disabled = busy || !canCreateOrder;
        freshReserve.textContent = activeAction === "reserve" ? "候补中…" : "下候补订单";
        clearToken.disabled = busy || !appState.tokenConfigured;
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
      function duration(seconds) { const value = Number(seconds); if (!Number.isFinite(value)) return '—'; if (value % 3600 === 0) return (value / 3600) + ' 小时'; if (value % 60 === 0) return (value / 60) + ' 分钟'; return Math.round(value) + ' 秒'; }
      function money(fen) { const value = Number(fen); return Number.isFinite(value) ? '¥' + (value / 100).toFixed(2) : '—'; }
      function esc(value) { return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
      function send(action, payload = {}) { vscode.postMessage({ type: 'bugteam:action', action, ...payload }); }
      function showNotice(message, level) { notice.textContent = message || ''; notice.className = 'notice visible ' + (level || ''); }
      function showToast(message, level) {
        window.clearTimeout(toastTimer);
        toast.textContent = message || '';
        toast.hidden = !message;
        toast.className = 'toast visible ' + (level || 'info');
        if (message) toastTimer = window.setTimeout(() => { toast.hidden = true; toast.className = 'toast'; }, 4_500);
      }
      render();
      send('ready');
    })();
  </script>
</body>
</html>`;
}

module.exports = { BUGTEAM_PANEL_VIEW_TYPE, createBugTeamPanelHtml };
