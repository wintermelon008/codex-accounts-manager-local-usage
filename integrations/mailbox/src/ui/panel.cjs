"use strict";

const crypto = require("node:crypto");

const MAILBOX_PANEL_VIEW_TYPE = "codexAccounts.mailbox";
const REGISTRATION_PANEL_VIEW_TYPE = "codexAccounts.mailboxRegistration";

function createMailboxPanelHtml({ mode = "mailbox" } = {}) {
  const registrationOnly = mode === "registration";
  const panelTitle = registrationOnly ? "注册助手" : "Mailbox";
  const panelSubtitle = registrationOnly
    ? "从邮箱库选择或输入新邮箱，手机号和验证码由你手动填写"
    : "邮箱列表与当前选中邮箱详情";
  const headerActions = registrationOnly
    ? '<button type="button" data-action="refresh">刷新本地状态</button><button type="button" class="danger" data-action="registration-cleanup-all">清除所有记录</button>'
    : '<button type="button" class="primary" data-action="open-import">添加邮箱</button><button type="button" data-action="toggle-registration">注册助手</button><button type="button" data-action="refresh">刷新本地状态</button>';
  const nonce = crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/gu, "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${panelTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
      --panel-soft: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, transparent);
      --border: var(--vscode-editorWidget-border);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --accent-strong: var(--vscode-button-background);
      --accent-text: var(--vscode-button-foreground);
      --danger: var(--vscode-errorForeground);
      --success: var(--vscode-testing-iconPassed);
      --warning: var(--vscode-editorWarning-foreground);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; min-height: 100vh; overflow: hidden; color: var(--text); background: var(--bg); font-family: var(--vscode-font-family); font-size: 13px; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button { border: 1px solid var(--border); border-radius: 6px; background: var(--panel-soft); padding: 7px 12px; cursor: pointer; transition: transform .08s ease, filter .08s ease, box-shadow .08s ease, border-color .12s ease, background-color .12s ease; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:active:not(:disabled), button.is-pressed:not(:disabled) { transform: translateY(1px); filter: brightness(.88); box-shadow: inset 0 1px 3px #0005; }
    button:focus-visible:not(:disabled) { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary { color: var(--accent-text); background: var(--accent-strong); border-color: var(--accent-strong); }
    button.danger { color: var(--danger); }
    button:disabled { opacity: .48; cursor: default; }
    input, select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-input-background); padding: 8px 10px; }
    textarea { min-height: 150px; resize: vertical; line-height: 1.55; }
    .shell { width: 100%; height: 100vh; min-height: 0; margin: 0; padding: 16px; display: flex; flex-direction: column; }
    .topbar { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
    .logo { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 9px; color: var(--accent-text); background: var(--accent-strong); font-weight: 700; font-size: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 24px; letter-spacing: -.02em; }
    h2 { font-size: 17px; }
    h3 { font-size: 14px; }
    .subtitle, .muted { color: var(--muted); }
    .subtitle { margin-top: 4px; }
    .top-actions, .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .notice { display: none; padding: 10px 12px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-soft); }
    .notice.visible { display: block; }
    .notice.success { color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, var(--border)); background: color-mix(in srgb, var(--success) 8%, transparent); }
    .notice.warning { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, var(--border)); background: color-mix(in srgb, var(--warning) 8%, transparent); }
    .notice.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .layout { flex: 1 1 auto; display: grid; grid-template-columns: minmax(240px, 310px) minmax(0, 1fr); gap: 14px; min-height: 0; }
    #app { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .box { min-height: 0; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
    .layout > .box:first-child { display: flex; flex-direction: column; }
    .box-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 15px; border-bottom: 1px solid var(--border); }
    .mailbox-list-header { align-items: flex-start; }
    .mailbox-list-toolbar { padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .mailbox-list-tools, .selection-tools, .batch-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .mailbox-list-tools input { flex: 1 1 150px; min-width: 120px; padding: 7px 9px; }
    .mailbox-list-tools select { width: auto; min-width: 112px; padding: 7px 8px; }
    .mailbox-list-tools label { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); white-space: nowrap; }
    .mailbox-list-tools label input { width: auto; }
    .selection-tools { justify-content: space-between; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .selection-tools button, .batch-tools button { padding: 5px 8px; font-size: 11px; }
    .batch-tools { margin-top: 8px; }
    .batch-tools .danger { color: var(--danger); }
    .mailbox-list { flex: 1; min-height: 0; max-height: none; overflow: auto; overscroll-behavior: contain; }
    .mailbox-row-wrap { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; border-bottom: 1px solid var(--border); }
    .mailbox-row-wrap:last-child { border-bottom: 0; }
    .mailbox-select { display: grid; place-items: start center; padding-top: 16px; cursor: pointer; }
    .mailbox-select input { width: auto; margin: 0; }
    .mailbox-row { display: block; width: 100%; min-width: 0; text-align: left; border: 0; border-radius: 0; background: transparent; padding: 13px 10px 13px 14px; }
    .mailbox-row.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 var(--accent); }
    .mailbox-row:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .mailbox-row-actions { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 0; background: transparent; }
    .mailbox-row-action { padding: 5px 6px; font-size: 11px; white-space: nowrap; }
    .row-number { color: var(--muted); margin-right: 6px; }
    .address { overflow-wrap: anywhere; word-break: break-word; }
    .row-title { font-weight: 650; line-height: 1.4; }
    .row-meta { display: flex; flex-wrap: wrap; gap: 6px 9px; margin-top: 7px; color: var(--muted); font-size: 12px; }
    .tag { display: inline-flex; align-items: center; width: fit-content; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-size: 11px; }
    .tag.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .tag.success { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
    .empty-list, .empty-detail { display: grid; place-items: center; min-height: 270px; padding: 28px; color: var(--muted); text-align: center; }
    .detail { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .detail-header { flex: none; padding: 18px 20px 14px; border-bottom: 1px solid var(--border); }
    .detail-header-actions { flex: none; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
    .detail-address { font-size: 18px; font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
    .detail-name { margin-top: 4px; color: var(--muted); overflow-wrap: anywhere; }
    .detail-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .detail-actions { flex: none; padding: 12px 20px; border-bottom: 1px solid var(--border); }
    .content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 16px 20px 22px; }
    .hero { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .hero-label { color: var(--muted); font-size: 12px; }
    .code { margin-top: 3px; color: var(--accent); font-size: clamp(34px, 6vw, 62px); font-weight: 800; letter-spacing: .08em; line-height: 1.1; }
    .hero-side { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 20px 0 10px; }
    .messages { border: 1px solid var(--border); border-radius: 8px; overflow: visible; }
    .message-entry { border-bottom: 1px solid var(--border); }
    .message-entry:last-child { border-bottom: 0; }
    .message-row { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; padding: 11px 12px; }
    .message-entry:last-child .message-row { border-bottom: 0; }
    .message-row.selected { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .message-subject { font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
    .message-time { margin-top: 5px; color: var(--muted); font-size: 11px; }
    .message-detail { border-top: 1px solid var(--border); padding: 15px; background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .message-detail h3 { margin-bottom: 9px; overflow-wrap: anywhere; }
    .from { color: var(--muted); overflow-wrap: anywhere; }
    .body { margin-top: 14px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
    .button-spinner { display: inline-block; width: 13px; height: 13px; margin-right: 6px; vertical-align: -2px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: mailbox-spin .75s linear infinite; }
    .is-pending { opacity: .82; }
    @keyframes mailbox-spin { to { transform: rotate(360deg); } }
    .modal-backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, #000 48%, transparent); }
    .modal { width: min(700px, 100%); max-height: calc(100vh - 40px); overflow: auto; padding: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--vscode-editorWidget-background); box-shadow: 0 18px 60px #0008; }
    .modal h2 { margin-bottom: 16px; }
    .field { margin-top: 13px; }
    .field label { display: block; margin-bottom: 6px; font-weight: 600; }
    .field-note { margin-top: 6px; color: var(--muted); line-height: 1.45; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .registration-panel { margin: 16px 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--vscode-editorWidget-background); overflow: hidden; }
    .registration-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--accent) 6%, transparent); cursor: pointer; user-select: none; }
    .registration-header:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .registration-header h2 { font-size: 15px; margin: 0; }
    .registration-toggle { font-size: 13px; color: var(--muted); }
    .registration-content { padding: 18px; }
    .registration-form { display: grid; gap: 12px; }
    .registration-form .field { margin: 0; }
    .registration-form input[type="email"], .registration-form input[type="password"], .registration-form input[type="text"], .registration-form input[type="number"] { width: 100%; }
    .registration-sessions { margin-top: 18px; }
    .registration-session { border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-top: 12px; background: color-mix(in srgb, var(--text) 3%, transparent); }
    .registration-session-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .registration-session-header-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
    .registration-session-email { font-weight: 650; overflow-wrap: anywhere; }
    .registration-session-status { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--muted); font-size: 13px; }
    .registration-session-status.success { color: var(--success); }
    .registration-session-status.error { color: var(--danger); }
    .registration-progress { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; margin: 12px 0 14px; }
    .registration-progress-step { min-width: 0; color: var(--muted); font-size: 10px; text-align: center; }
    .registration-progress-bar { height: 4px; margin-bottom: 5px; border-radius: 99px; background: var(--border); }
    .registration-progress-step.done .registration-progress-bar { background: var(--success); }
    .registration-progress-step.current .registration-progress-bar { background: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .registration-progress-step.current { color: var(--accent); font-weight: 650; }
    .registration-progress-step.failed .registration-progress-bar { background: var(--danger); }
    .registration-session-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .registration-session-input { margin-top: 10px; }
    .registration-session-input input { width: 100%; }
    .registration-input-with-action { display: flex; gap: 6px; align-items: flex-start; }
    .registration-input-with-action input { min-width: 0; flex: 1 1 auto; }
    .registration-input-with-action button { flex: none; white-space: nowrap; }
    .registration-credential-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .registration-credential-grid .registration-session-input { margin-top: 0; }
    .registration-phone-order { margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--accent) 3%, transparent); }
    .registration-phone-order-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 10px; }
    .registration-phone-order-head strong { font-size: 13px; }
    .registration-phone-order-source { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--muted); font-size: 11px; }
    .registration-phone-order-source a { color: var(--accent); }
    .registration-phone-success-rate { color: var(--muted); }
    .registration-phone-config { display: grid; grid-template-columns: minmax(150px, .8fr) minmax(180px, 1.2fr); gap: 8px; margin-top: 10px; }
    .registration-phone-config .field { margin-top: 0; }
    .registration-phone-config textarea { min-height: 54px; height: 54px; resize: vertical; }
    .registration-phone-config button { margin-top: 6px; }
    .registration-key-pool { margin-top: 8px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent); }
    .registration-key-pool summary { cursor: pointer; color: var(--muted); font-size: 11px; user-select: none; }
    .registration-key-pool[open] summary { margin-bottom: 7px; color: var(--text); }
    .registration-key-pool-count { margin-left: 6px; color: var(--muted); }
    .registration-key-pool-list { display: grid; gap: 5px; margin-top: 8px; }
    .registration-key-pool-row { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--muted); font-size: 11px; }
    .registration-key-pool-row .key-mask { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
    .registration-key-pool-row button { padding: 3px 7px; font-size: 11px; }
    .registration-countdown { color: var(--muted); font-size: 11px; }
    .registration-phone-order-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .registration-phone-result { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-editor-background); }
    .registration-phone-result label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; }
    .registration-phone-result strong { display: block; min-height: 20px; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .registration-phone-result button { margin-top: 7px; }
    .registration-phone-order-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .registration-phone-order .field-note { margin-top: 8px; }
    .registration-email-code { margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--success) 3%, transparent); }
    .registration-email-code-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .registration-email-code-head strong { font-size: 13px; }
    .registration-email-code-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, .7fr); gap: 8px; margin-top: 10px; }
    .registration-email-code-result { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-editor-background); }
    .registration-email-code-result label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; }
    .registration-email-code-result strong { display: block; min-height: 20px; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .registration-email-code-result button { margin-top: 7px; }
    .registration-email-code .field-note { margin-top: 8px; }
    .registration-collapsed .registration-content { display: none; }
    .registration-standalone { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 20px 22px; }
    .registration-standalone-card { max-width: 980px; margin: 0 auto; padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--vscode-editorWidget-background); }
    .registration-standalone-card + .registration-standalone-card { margin-top: 14px; }
    .registration-standalone-card h2 { margin-bottom: 6px; }
    .registration-mailbox-picker { margin-top: 16px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--accent) 3%, transparent); }
    .registration-mailbox-picker-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .registration-mailbox-picker-tools { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .registration-mailbox-picker-tools input { flex: 1 1 220px; min-width: 160px; }
    .registration-mailbox-picker-tools select { width: auto; min-width: 130px; }
    .registration-mailbox-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 8px; max-height: 250px; margin-top: 10px; overflow: auto; }
    .registration-mailbox-option { min-width: 0; padding: 10px; text-align: left; }
    .registration-mailbox-option.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 var(--accent); }
    .registration-mailbox-option-title { font-weight: 650; overflow-wrap: anywhere; }
    .registration-mailbox-option-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; color: var(--muted); font-size: 11px; }
    .registration-standalone-content { margin-top: 14px; }
    .registration-standalone-content .registration-form { padding-top: 0; }
    @media (max-width: 820px) {
      body { padding: 0; }
      .topbar { display: block; }
      .top-actions { margin-top: 12px; justify-content: flex-start; }
      body { overflow: auto; }
      .shell { height: auto; min-height: 100vh; }
      .layout { flex: none; grid-template-columns: 1fr; min-height: 0; }
      .layout > .box { height: auto; }
      .mailbox-list { flex: none; min-height: 180px; max-height: 280px; }
      .mailbox-row-action { padding-inline: 5px; }
      .registration-phone-config { grid-template-columns: 1fr; }
      .registration-standalone { padding-inline: 0; }
      .registration-mailbox-list { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">${registrationOnly ? "R" : "M"}</div>
        <div><h1>${panelTitle}</h1><p class="subtitle">${panelSubtitle}</p></div>
      </div>
      <div class="top-actions">${headerActions}</div>
    </header>
    <div id="notice" class="notice" role="status"></div>
    <main id="app"></main>
  </div>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const registrationOnly = ${registrationOnly};
      const app = document.getElementById("app");
      const notice = document.getElementById("notice");
      let state = { mailboxes: [], providers: [] };
      let importOpen = false;
      let importProvider = "";
      let selectedMessageId = "";
      let mailboxSearch = "";
      let mailboxSort = "nameAsc";
      let onlyUnlinkedCodex = false;
      let providerFilter = "";
      let selectedMailboxIds = new Set();
      let pendingBatchAction = "";
      let pendingActions = {};
      let pendingCodexImports = {};
      let editOpenMailboxId = "";
      let editProvider = "";
      let deleteConfirm = undefined;
      let registrationPanelOpen = false;
      let registrationEmail = "";
      let selectedRegistrationMailboxId = "";
      let registrationMailboxSearch = "";
      let registrationMailboxSort = "nameAsc";
      let registrationMailboxProviderFilter = "";
      let registrationMaxRetries = 25;
      let registrationPhoneKeyInputs = {};
      let registrationPhoneSourceSelections = {};
      let registrationPhoneKeySelections = {};
      let registrationInputValues = {};
      let registrationCountdownTimer;

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "state") {
          state = message.state || state;
          pendingCodexImports = Object.fromEntries((state.codexImports || []).map((mailboxId) => [mailboxId, true]));
          const knownMailboxIds = new Set((state.mailboxes || []).map((mailbox) => mailbox.id));
          selectedMailboxIds = new Set([...selectedMailboxIds].filter((mailboxId) => knownMailboxIds.has(mailboxId)));
          if (!state.codexImportAvailable) onlyUnlinkedCodex = false;
          if (providerFilter && !(state.providers || []).some((provider) => provider.id === providerFilter)) providerFilter = "";
          if (registrationMailboxProviderFilter && !(state.providers || []).some((provider) => provider.id === registrationMailboxProviderFilter)) registrationMailboxProviderFilter = "";
          if (selectedRegistrationMailboxId && !(state.mailboxes || []).some((mailbox) => mailbox.id === selectedRegistrationMailboxId)) {
            selectedRegistrationMailboxId = "";
          }
          const selectedRegistrationMailbox = (state.mailboxes || []).find((mailbox) => mailbox.id === selectedRegistrationMailboxId);
          if (selectedRegistrationMailbox && hasManagedCodexEmail(selectedRegistrationMailbox.address)) {
            selectedRegistrationMailboxId = "";
            if (normalizeEmail(registrationEmail) === normalizeEmail(selectedRegistrationMailbox.address)) registrationEmail = "";
          }
          if (!importProvider && state.providers?.[0]) importProvider = state.providers[0].id;
          if (state.selected?.detail?.messages && !state.selected.detail.messages.some((item) => item.id === selectedMessageId)) {
            selectedMessageId = state.selected.detail.messages[0]?.id || "";
          }
          render();
        }
        if (message.type === "operation-complete") {
          pendingBatchAction = "";
          const mailboxId = message.mailboxId || state.selectedMailboxId;
          if (mailboxId && pendingActions[mailboxId] === message.action) {
            pendingActions[mailboxId] = "";
          }
          render();
        }
        if (message.type === "toast") {
          if (["query", "wait", "renewal", "batchStop", "batchDelete"].includes(message.action)) pendingBatchAction = "";
          if (message.level === "success" || message.level === "warning" || message.level === "error") {
            const mailboxId = message.mailboxId || state.selectedMailboxId;
            if (mailboxId && message.action === "codexImport") pendingCodexImports[mailboxId] = false;
            if (mailboxId && (message.action === "stop" || !message.action || pendingActions[mailboxId] === message.action)) {
              pendingActions[mailboxId] = "";
            }
          }
          showNotice(message.message, message.level);
          render();
        }
      });

      document.addEventListener("pointerdown", (event) => {
        const target = closestTarget(event, "button:not(:disabled)");
        target?.classList.add("is-pressed");
      });
      document.addEventListener("pointerup", (event) => {
        const target = closestTarget(event, "button");
        target?.classList.remove("is-pressed");
        clearPressedButtons();
      });
      document.addEventListener("pointercancel", (event) => {
        const target = closestTarget(event, "button");
        target?.classList.remove("is-pressed");
        clearPressedButtons();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = closestTarget(event, "button:not(:disabled)");
        target?.classList.add("is-pressed");
      });
      document.addEventListener("keyup", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = closestTarget(event, "button");
        target?.classList.remove("is-pressed");
        clearPressedButtons();
      });
      window.addEventListener("blur", clearPressedButtons);
      document.addEventListener("click", (event) => {
        const target = closestTarget(event, "[data-action]");
        if (!target || target.disabled) return;
        const action = target.dataset.action;
        if (action === "select-mailbox") send("select", { mailboxId: target.dataset.mailboxId });
        else if (action === "registration-select-mailbox") selectRegistrationMailbox(target.dataset.mailboxId || "");
        else if (action === "registration-delete-mailbox") {
          const mailboxId = target.dataset.mailboxId || "";
          if (mailboxId) send("registrationDeleteMailbox", { mailboxId });
        }
        else if (action === "toggle-mailbox") toggleMailboxSelection(target.dataset.mailboxId || "");
        else if (action === "select-visible") selectVisibleMailboxes();
        else if (action === "clear-selection") { selectedMailboxIds.clear(); render(); }
        else if (action === "batch-query") requestBatchAction("batchQuery");
        else if (action === "batch-wait") requestBatchAction("batchWait");
        else if (action === "batch-renewal") requestBatchAction("batchRenewal");
        else if (action === "batch-stop") requestBatchAction("batchStop");
        else if (action === "batch-delete") requestBatchDelete();
        else if (action === "select-message") { selectedMessageId = target.dataset.messageId || ""; render(); }
        else if (action === "open-import") {
          importOpen = true;
          render();
          if (!(state.providers || []).length) send("refresh");
        }
        else if (action === "close-import") { importOpen = false; render(); }
        else if (action === "close-edit") { editOpenMailboxId = ""; render(); }
        else if (action === "cancel-delete") { deleteConfirm = undefined; render(); }
        else if (action === "confirm-delete") confirmDelete();
        else if (action === "edit-mailbox") openEditModal(target.dataset.mailboxId || "");
        else if (action === "delete-mailbox") requestDelete(target.dataset.mailboxId || "");
        else if (action === "codex-import") requestCodexImport(target.dataset.mailboxId || state.selectedMailboxId);
        else if (action === "submit-query" || action === "submit-wait" || action === "submit-renewal" || action === "stop") {
          requestAction(action.replace("submit-", ""), state.selectedMailboxId);
        }
        else if (action === "refresh") send("refresh");
        else if (action === "registration-cleanup-all") {
          for (const session of state.registrationSessions || []) clearRegistrationSessionClientState(session.id);
          send("registrationCleanupAll");
        }
        else if (action === "copy-code") copyCode(target.dataset.code || "");
        else if (action === "registration-refresh-email-code") {
          const sessionId = target.dataset.sessionId;
          if (sessionId) send("registrationRefreshEmailCode", { sessionId });
        }
        else if (action === "registration-copy-phone" || action === "registration-copy-code" || action === "registration-copy-email-code") {
          copyText(
            target.dataset.value || "",
            action === "registration-copy-phone" ? "手机号已复制" : action === "registration-copy-email-code" ? "邮箱验证码已复制" : "验证码已复制"
          );
        }
        else if (action === "toggle-registration") { registrationPanelOpen = !registrationPanelOpen; render(); }
        else if (action === "registration-create") {
          const emailInput = document.getElementById("registrationEmailInput");
          const email = emailInput?.value?.trim() || "";
          if (!email) return;
          if (hasManagedCodexEmail(email)) {
            showNotice("该邮箱已经导入 Codex 账号，请选择其他邮箱", "warning");
            return;
          }
          void copyText(email, "邮箱已复制");
          send("registrationCreate", { email, maxRetries: registrationMaxRetries });
        }
        else if (action === "registration-fill-email-code") {
          fillRegistrationInput(target.dataset.sessionId || "", "emailCode", target.dataset.value || "");
        }
        else if (action === "registration-fill-phone") {
          fillRegistrationInput(target.dataset.sessionId || "", "phone", target.dataset.value || "");
        }
        else if (action === "registration-fill-code") {
          fillRegistrationInput(target.dataset.sessionId || "", "otp", target.dataset.value || "");
        }
        else if (action === "registration-authorize") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationAuthorize", { sessionId });
        }
        else if (action === "registration-submit-email-code") {
          const sessionId = target.dataset.sessionId;
          const code = registrationInputValues[sessionId]?.emailCode?.trim() || document.getElementById("emailCodeInput-" + sessionId)?.value?.trim() || "";
          if (!sessionId || !code) return;
          send("registrationSubmitEmailCode", { sessionId, code });
        }
        else if (action === "registration-submit-phone") {
          const sessionId = target.dataset.sessionId;
          const phoneNumber = registrationInputValues[sessionId]?.phone?.trim() || document.getElementById("phoneInput-" + sessionId)?.value?.trim() || "";
          if (!sessionId || !phoneNumber) return;
          send("registrationSubmitPhone", { sessionId, phoneNumber });
        }
        else if (action === "registration-submit-otp") {
          const sessionId = target.dataset.sessionId;
          const otp = registrationInputValues[sessionId]?.otp?.trim() || document.getElementById("otpInput-" + sessionId)?.value?.trim() || "";
          if (!sessionId || !otp) return;
          send("registrationSubmitOtp", { sessionId, otp });
        }
        else if (action === "registration-acquire-phone") {
          const sessionId = target.dataset.sessionId;
          const sourceId = registrationPhoneSourceSelections[sessionId] || document.getElementById("registrationPhoneSource-" + sessionId)?.value || "liye";
          const keyId = registrationPhoneKeySelections[sessionId] || document.getElementById("registrationPhoneKey-" + sessionId)?.value || "";
          if (!sessionId || !keyId) {
            showNotice("请先选择接码平台 Key", "warning");
            return;
          }
          send("registrationAcquirePhone", { sessionId, sourceId, keyId });
        }
        else if (action === "registration-confirm-phone") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationConfirmPhone", { sessionId });
        }
        else if (action === "registration-replace-phone") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationReplacePhone", { sessionId });
        }
        else if (action === "registration-cancel-phone") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationCancelPhone", { sessionId });
        }
        else if (action === "registration-add-phone-key") {
          const sessionId = target.dataset.sessionId || "";
          const input = document.getElementById("registrationPhoneKeyInput-" + sessionId)?.value?.trim() || registrationPhoneKeyInputs[sessionId] || "";
          if (!input) {
            showNotice("请先粘贴至少一个接码平台 Key", "warning");
            return;
          }
          registrationPhoneKeyInputs[sessionId] = "";
          send("registrationAddPhoneKeys", { input });
          render();
        }
        else if (action === "registration-remove-phone-key") {
          const keyId = target.dataset.keyId || "";
          if (keyId) send("registrationRemovePhoneKey", { keyId });
        }
        else if (action === "registration-request-new-phone") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationRequestNewPhone", { sessionId });
        }
        else if (action === "registration-cancel") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          send("registrationCancel", { sessionId });
        }
        else if (action === "registration-cleanup") {
          const sessionId = target.dataset.sessionId;
          if (!sessionId) return;
          clearRegistrationSessionClientState(sessionId);
          send("registrationCleanup", { sessionId });
        }
      });

      document.addEventListener("change", (event) => {
        const target = closestTarget(event, "input, select, textarea");
        if (!target) return;
        if (target.id === "providerId") { importProvider = target.value; render(); }
        if (target.id === "editProviderId") { editProvider = target.value || ""; }
        if (target.id === "mailboxSort") { mailboxSort = target.value || "nameAsc"; render(); }
        if (target.id === "onlyUnlinkedCodex") { onlyUnlinkedCodex = target.checked === true; render(); }
        if (target.id === "mailboxProviderFilter") { providerFilter = target.value || ""; render(); }
        if (target.id === "registrationMailboxSort") { registrationMailboxSort = target.value || "nameAsc"; render(); }
        if (target.id === "registrationMailboxProviderFilter") { registrationMailboxProviderFilter = target.value || ""; render(); }
        if (target.id.startsWith("registrationPhoneSource-")) {
          registrationPhoneSourceSelections[target.id.slice("registrationPhoneSource-".length)] = target.value || "liye";
        }
        if (target.id.startsWith("registrationPhoneKey-")) {
          const sessionId = target.id.slice("registrationPhoneKey-".length);
          registrationPhoneKeySelections[sessionId] = target.value || "";
          // The acquire button is initially disabled when no key is selected.
          // Enable it immediately after a valid available key is chosen instead
          // of waiting for a state event to re-render the whole panel.
          updateRegistrationAcquireButton(sessionId);
        }
        if (target.matches(".mailbox-checkbox")) toggleMailboxSelection(target.value || "", target.checked);
      });
      document.addEventListener("input", (event) => {
        if (event.target.id === "mailboxSearch") { mailboxSearch = event.target.value || ""; render(); document.getElementById("mailboxSearch")?.focus(); }
        if (event.target.id === "registrationMailboxSearch") {
          registrationMailboxSearch = event.target.value || "";
          render();
          document.getElementById("registrationMailboxSearch")?.focus();
        }
        if (event.target.id === "registrationEmailInput") {
          const previousMailboxId = selectedRegistrationMailboxId;
          registrationEmail = event.target.value || "";
          const selectedMailbox = (state.mailboxes || []).find((mailbox) => mailbox.id === selectedRegistrationMailboxId);
          if (!selectedMailbox || selectedMailbox.address.trim().toLowerCase() !== registrationEmail.trim().toLowerCase()) {
            selectedRegistrationMailboxId = "";
          }
          if (previousMailboxId && !selectedRegistrationMailboxId) render();
        }
        if (event.target.id.startsWith("registrationPhoneKeyInput-")) {
          registrationPhoneKeyInputs[event.target.id.slice("registrationPhoneKeyInput-".length)] = event.target.value || "";
        }
        if (event.target.id.startsWith("phoneInput-")) {
          const sessionId = event.target.id.slice("phoneInput-".length);
          registrationInputValues[sessionId] = { ...(registrationInputValues[sessionId] || {}), phone: event.target.value || "" };
        }
        if (event.target.id.startsWith("emailCodeInput-")) {
          const sessionId = event.target.id.slice("emailCodeInput-".length);
          registrationInputValues[sessionId] = { ...(registrationInputValues[sessionId] || {}), emailCode: event.target.value || "" };
        }
        if (event.target.id.startsWith("otpInput-")) {
          const sessionId = event.target.id.slice("otpInput-".length);
          registrationInputValues[sessionId] = { ...(registrationInputValues[sessionId] || {}), otp: event.target.value || "" };
        }
      });
      document.addEventListener("submit", (event) => {
        if (event.target.id === "editForm") {
          event.preventDefault();
          const form = new FormData(event.target);
          const mailboxId = editOpenMailboxId;
          if (!mailboxId) return;
          pendingActions[mailboxId] = "edit";
          editOpenMailboxId = "";
          render();
          send("edit", { mailboxId, providerId: form.get("providerId"), displayName: form.get("displayName"), input: form.get("input") });
          return;
        }
        if (event.target.id !== "importForm") return;
        event.preventDefault();
        const form = new FormData(event.target);
        send("import", { providerId: form.get("providerId"), displayName: form.get("displayName"), input: form.get("input") });
        importOpen = false;
      });

      function render() {
        const mailboxList = document.querySelector(".mailbox-list");
        const content = document.querySelector(".content");
        const searchInput = document.getElementById("mailboxSearch");
        const registrationSearchInput = document.getElementById("registrationMailboxSearch");
        const registrationEmailInput = document.getElementById("registrationEmailInput");
        const keepSearchFocus = document.activeElement === searchInput;
        const searchSelectionStart = searchInput?.selectionStart;
        const searchSelectionEnd = searchInput?.selectionEnd;
        const keepRegistrationSearchFocus = document.activeElement === registrationSearchInput;
        const registrationSearchSelectionStart = registrationSearchInput?.selectionStart;
        const registrationSearchSelectionEnd = registrationSearchInput?.selectionEnd;
        const keepRegistrationEmailFocus = document.activeElement === registrationEmailInput;
        const registrationEmailSelectionStart = registrationEmailInput?.selectionStart;
        const registrationEmailSelectionEnd = registrationEmailInput?.selectionEnd;
        const mailboxScrollTop = mailboxList?.scrollTop || 0;
        const contentScrollTop = content?.scrollTop || 0;
        const registrationStandalone = document.querySelector(".registration-standalone");
        const registrationStandaloneScrollTop = registrationStandalone?.scrollTop || 0;
        document.querySelector(".modal-backdrop")?.remove();
        document.getElementById("registrationPanel")?.remove();
        if (registrationOnly) {
          app.innerHTML = renderStandaloneRegistration();
        } else {
          app.insertAdjacentHTML("beforebegin", renderRegistrationPanel());
          app.innerHTML = renderLayout();
        }
        if (importOpen) document.body.insertAdjacentHTML("beforeend", renderImportModal());
        if (editOpenMailboxId) document.body.insertAdjacentHTML("beforeend", renderEditModal());
        if (deleteConfirm) document.body.insertAdjacentHTML("beforeend", renderDeleteConfirmModal());
        const nextMailboxList = document.querySelector(".mailbox-list");
        const nextContent = document.querySelector(".content");
        const nextRegistrationStandalone = document.querySelector(".registration-standalone");
        if (nextMailboxList) nextMailboxList.scrollTop = mailboxScrollTop;
        if (nextContent) nextContent.scrollTop = contentScrollTop;
        if (nextRegistrationStandalone) nextRegistrationStandalone.scrollTop = registrationStandaloneScrollTop;
        if (keepSearchFocus) {
          const nextSearchInput = document.getElementById("mailboxSearch");
          nextSearchInput?.focus();
          if (searchSelectionStart != null && searchSelectionEnd != null) {
            nextSearchInput?.setSelectionRange(searchSelectionStart, searchSelectionEnd);
          }
        }
        if (keepRegistrationSearchFocus) {
          const nextSearchInput = document.getElementById("registrationMailboxSearch");
          nextSearchInput?.focus();
          if (registrationSearchSelectionStart != null && registrationSearchSelectionEnd != null) {
            nextSearchInput?.setSelectionRange(registrationSearchSelectionStart, registrationSearchSelectionEnd);
          }
        }
        if (keepRegistrationEmailFocus) {
          const nextEmailInput = document.getElementById("registrationEmailInput");
          nextEmailInput?.focus();
          if (registrationEmailSelectionStart != null && registrationEmailSelectionEnd != null) {
            nextEmailInput?.setSelectionRange(registrationEmailSelectionStart, registrationEmailSelectionEnd);
          }
        }
        updateRegistrationCountdowns();
        ensureRegistrationCountdownTimer();
      }

      const REGISTRATION_STATE_LABELS = {
        idle: "空闲",
        starting: "正在启动浏览器",
        awaiting_account_details: "填写账号信息",
        awaiting_oauth: "等待 Codex OAuth 浏览器完成",
        awaiting_email_code: "等待输入邮箱验证码",
        submitting_email_code: "正在提交邮箱验证码",
        awaiting_phone_input: "等待输入手机号",
        submitting_phone: "正在提交手机号",
        awaiting_otp_input: "等待输入验证码",
        submitting_otp: "正在提交验证码",
        awaiting_profile: "正在填写姓名年龄",
        submitting_profile: "正在提交姓名年龄",
        awaiting_authorization: "等待最后继续",
        submitting_authorization: "正在提交最后继续",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消"
      };

      const PHONE_ORDER_PHASE_LABELS = {
        idle: "未取号",
        logging_in: "连接接码平台",
        purchasing: "正在取号",
        waiting: "已取号，准备读取验证码",
        polling: "正在读取验证码",
        replacing: "正在重新取号",
        cancelling: "正在取消取号",
        received: "已收到验证码",
        completed: "已完成",
        cancelled: "已取消",
        timed_out: "读取超时",
        error: "取号失败"
      };

      const EMAIL_CODE_PHASE_LABELS = {
        idle: "未开始查询",
        searching: "正在查询邮箱",
        received: "已收到邮箱验证码",
        expired: "查询窗口已结束",
        cancelled: "已停止查询",
        error: "邮箱查询失败"
      };

      function renderRegistrationPanel() {
        const sessions = [...(state.registrationSessions || [])].reverse();
        const collapsedClass = registrationPanelOpen ? "" : " registration-collapsed";
        const sessionsHtml = sessions.length
          ? sessions.map(renderRegistrationSession).join("")
          : '<p class="muted">还没有注册会话。填写邮箱后创建会话；接码平台拿到号码后会自动读取验证码，换号和取消取号仍需你点击，手机号和验证码不会自动填写或提交。</p>';
        return '<div id="registrationPanel" class="registration-panel' + collapsedClass + '">' +
          '<div class="registration-header" data-action="toggle-registration"><h2>注册助手</h2><span class="registration-toggle">' + (registrationPanelOpen ? "收起 ▲" : "展开 ▼") + '</span></div>' +
          '<div class="registration-content">' +
            renderRegistrationCreateForm() +
            '<div class="registration-sessions">' + sessionsHtml + '</div>' +
          '</div>' +
        '</div>';
      }

      function renderRegistrationCreateForm() {
        return '<div class="registration-form">' +
          '<div class="field"><label for="registrationEmailInput">邮箱</label><input id="registrationEmailInput" type="email" value="' + esc(registrationEmail) + '" placeholder="your-email@example.com"></div>' +
          '<div><button type="button" data-action="registration-create" class="primary">开始注册</button></div>' +
          '<p class="field-note">开始注册后优先使用 Codex OAuth 浏览器流程；邮箱、密码、手机号、验证码和最终授权在浏览器中完成。面板只显示/复制邮箱码和接码内容，不会自动填写或提交。重新取号与取消取号均不会自动发生。</p>' +
        '</div>';
      }

      function renderStandaloneRegistration() {
        const allMailboxes = state.mailboxes || [];
        const mailboxes = [...filterRegistrationMailboxes()].sort(compareRegistrationMailboxes);
        const managedCount = allMailboxes.filter((mailbox) => hasManagedCodexEmail(mailbox.address)).length;
        const providerOptions = (state.providers || []).map((provider) =>
          '<option value="' + esc(provider.id) + '" ' + (registrationMailboxProviderFilter === provider.id ? "selected" : "") + '>' +
          esc(provider.displayName || provider.id) + '（' + esc(provider.id) + '）</option>'
        ).join("");
        const mailboxRows = mailboxes.length
          ? mailboxes.map(renderRegistrationMailboxOption).join("")
          : '<div class="empty-list" style="min-height:120px;grid-column:1/-1">' +
            (allMailboxes.length && managedCount === allMailboxes.length ? "邮箱库中的邮箱均已导入 Codex，请直接输入其他邮箱。" : allMailboxes.length ? "没有匹配的已导入邮箱。" : "邮箱库为空，请直接输入新邮箱。") +
            '</div>';
        const managedNote = managedCount
          ? '<div class="field-note">已自动隐藏 ' + managedCount + ' 个已经导入 Codex 的邮箱。</div>'
          : '';
        const sessions = [...(state.registrationSessions || [])].reverse();
        const sessionsHtml = sessions.length
          ? sessions.map(renderRegistrationSession).join("")
          : '<p class="muted">还没有注册会话。先从上方选择已导入邮箱，或直接输入新邮箱。</p>';
        return '<div class="registration-standalone">' +
          '<section class="registration-standalone-card">' +
            '<h2>选择注册邮箱</h2>' +
            '<p class="muted">可按邮箱库筛选并点击选择，也可以在下方直接输入一个新邮箱。选择邮箱只会填入地址，不会自动开始注册。</p>' +
            '<div class="registration-mailbox-picker">' +
              '<div class="registration-mailbox-picker-head"><strong>已导入邮箱库</strong><span class="tag">' + mailboxes.length + '/' + allMailboxes.length + '</span></div>' +
              '<div class="registration-mailbox-picker-tools"><input id="registrationMailboxSearch" type="search" value="' + esc(registrationMailboxSearch) + '" placeholder="输入邮箱前缀实时筛选" aria-label="按邮箱前缀搜索注册邮箱"><select id="registrationMailboxProviderFilter" aria-label="按邮箱来源筛选注册邮箱"><option value="">全部来源</option>' + providerOptions + '</select><select id="registrationMailboxSort" aria-label="注册邮箱排序"><option value="nameAsc" ' + (registrationMailboxSort === "nameAsc" ? "selected" : "") + '>名称升序</option><option value="nameDesc" ' + (registrationMailboxSort === "nameDesc" ? "selected" : "") + '>名称降序</option><option value="queryDesc" ' + (registrationMailboxSort === "queryDesc" ? "selected" : "") + '>最近查询</option><option value="codeFirst" ' + (registrationMailboxSort === "codeFirst" ? "selected" : "") + '>已出码优先</option></select></div>' +
              '<div class="registration-mailbox-list">' + mailboxRows + '</div>' + managedNote +
            '</div>' +
            '<div class="registration-standalone-content">' + renderRegistrationCreateForm() + '</div>' +
          '</section>' +
          '<section class="registration-standalone-card"><div class="registration-sessions">' + sessionsHtml + '</div></section>' +
        '</div>';
      }

      function renderRegistrationMailboxOption(mailbox) {
        const selected = mailbox.id === selectedRegistrationMailboxId;
        const provider = (state.providers || []).find((item) => item.id === mailbox.providerId);
        return '<button type="button" class="registration-mailbox-option' + (selected ? ' selected' : '') + '" data-action="registration-select-mailbox" data-mailbox-id="' + esc(mailbox.id) + '"><div class="registration-mailbox-option-title">' + esc(mailbox.displayName || mailbox.address) + '</div><div class="address">' + esc(mailbox.address) + '</div><div class="registration-mailbox-option-meta"><span>' + esc(provider?.displayName || mailbox.providerId || "未知来源") + '</span>' + (mailbox.latestCode ? '<span class="tag success">验证码 ' + esc(mailbox.latestCode) + '</span>' : '') + '</div></button>';
      }

      function filterRegistrationMailboxes() {
        const query = registrationMailboxSearch.trim().toLowerCase();
        return (state.mailboxes || []).filter((mailbox) => {
          if (hasManagedCodexEmail(mailbox.address)) return false;
          if (query && !matchesMailboxSearch(mailbox, query)) return false;
          if (registrationMailboxProviderFilter && mailbox.providerId !== registrationMailboxProviderFilter) return false;
          return true;
        });
      }

      function compareRegistrationMailboxes(left, right) {
        if (registrationMailboxSort === "queryDesc") return (right.lastQueryAt || 0) - (left.lastQueryAt || 0) || compareText(left, right);
        if (registrationMailboxSort === "codeFirst") return Number(Boolean(right.latestCode)) - Number(Boolean(left.latestCode)) || compareText(left, right);
        const result = compareText(left, right);
        return registrationMailboxSort === "nameDesc" ? -result : result;
      }

      function selectRegistrationMailbox(mailboxId) {
        const mailbox = (state.mailboxes || []).find((item) => item.id === mailboxId);
        if (!mailbox) return;
        selectedRegistrationMailboxId = mailbox.id;
        registrationEmail = mailbox.address || "";
        render();
      }

      function renderRegistrationSession(session) {
        const registrationMailbox = (state.mailboxes || []).find((mailbox) => normalizeEmail(mailbox.address) === normalizeEmail(session.email));
        const label = session.mode === "oauth" && session.state === "completed"
          ? "Codex OAuth 导入完成"
          : REGISTRATION_STATE_LABELS[session.state] || session.state;
        const sessionStatusClass = session.state === "completed" ? " success" : session.state === "failed" ? " error" : "";
        const progressHtml = session.mode === "oauth"
          ? '<div class="field-note" role="status">当前路线：Codex OAuth。注册页面由外部浏览器承载，完成后结果会自动回传并导入 Manager。</div>'
          : renderRegistrationProgress(session.state);
        const inputHtml = renderRegistrationInputs(session);
        const phoneOrderHtml = renderPhoneOrder(session);
        const emailCodeHtml = renderRegistrationEmailCode(session);
        const errorHtml = session.error ? '<div class="tag" style="margin-top:8px;color:var(--danger)">' + esc(session.error) + '</div>' : "";
        const feedbackHtml = session.feedback && session.feedback !== session.error
          ? session.feedbackLevel === "error"
            ? '<div class="tag error" style="margin-top:8px" role="status">' + esc(session.feedback) + '</div>'
            : session.feedbackLevel === "success"
              ? '<div class="tag success" style="margin-top:8px" role="status">' + esc(session.feedback) + '</div>'
              : '<div class="field-note" style="margin-top:8px" role="status">' + esc(session.feedback) + '</div>'
          : "";
        const mailboxDeleteButton = registrationMailbox
          ? '<button type="button" class="secondary small danger" data-action="registration-delete-mailbox" data-mailbox-id="' + esc(registrationMailbox.id) + '" title="直接从邮箱库删除该邮箱">删除邮箱</button>'
          : "";
        return '<div class="registration-session">' +
          '<div class="registration-session-header"><span class="registration-session-email">' + esc(session.email) + '</span><span class="registration-session-header-actions"><span class="tag">' + (session.mode === "oauth" ? "Codex OAuth" : '已尝试号码 ' + (session.phoneInputCount || 0) + ' 次') + '</span>' + mailboxDeleteButton + '</span></div>' +
          '<div class="registration-session-status' + sessionStatusClass + '">' + esc(label) + '</div>' +
          progressHtml +
          errorHtml +
          feedbackHtml +
          emailCodeHtml +
          phoneOrderHtml +
          inputHtml +
        '</div>';
      }

      function renderRegistrationProgress(stateName) {
        const steps = [
          { key: "account", label: "密码" },
          { key: "email", label: "邮箱码" },
          { key: "phone", label: "手机号" },
          { key: "sms", label: "短信码" },
          { key: "profile", label: "姓名年龄" },
          { key: "authorization", label: "最后继续" }
        ];
        const currentIndex = registrationProgressIndex(stateName);
        return '<div class="registration-progress" aria-label="注册进度">' + steps.map((step, index) => {
          const status = stateName === "failed" && index === Math.max(0, currentIndex) ? "failed" : index < currentIndex ? "done" : index === currentIndex ? "current" : "";
          return '<div class="registration-progress-step ' + status + '"><div class="registration-progress-bar"></div><span>' + step.label + '</span></div>';
        }).join("") + '</div>';
      }

      function registrationProgressIndex(stateName) {
        if (["idle", "starting", "awaiting_account_details"].includes(stateName)) return 0;
        if (["awaiting_email_code", "submitting_email_code"].includes(stateName)) return 1;
        if (["awaiting_phone_input", "submitting_phone"].includes(stateName)) return 2;
        if (["awaiting_otp_input", "submitting_otp"].includes(stateName)) return 3;
        if (["awaiting_profile", "submitting_profile"].includes(stateName)) return 4;
        if (["awaiting_authorization", "submitting_authorization"].includes(stateName)) return 5;
        if (stateName === "completed") return 6;
        return 0;
      }

      function renderRegistrationEmailCode(session) {
        const emailCode = session.emailCode || {};
        const phase = String(emailCode.phase || "idle");
        const code = String(emailCode.code || "").trim();
        const receivedAt = String(emailCode.receivedAt || "").trim();
        const phaseLabel = EMAIL_CODE_PHASE_LABELS[phase] || phase;
        const statusClass = phase === "received" ? " success" : phase === "error" ? " error" : "";
        const copyButton = code
          ? '<button type="button" class="secondary small" data-action="registration-copy-email-code" data-session-id="' + esc(session.id) + '" data-value="' + esc(code) + '">复制邮箱验证码</button>'
          : '<button type="button" class="secondary small" disabled>复制邮箱验证码</button>';
        const terminal = ["completed", "failed", "cancelled"].includes(session.state);
        const refreshButton = terminal
          ? '<button type="button" class="secondary small" disabled>重新查询</button>'
          : '<button type="button" class="secondary small" data-action="registration-refresh-email-code" data-session-id="' + esc(session.id) + '">重新查询</button>';
        const detail = emailCode.subject ? ' · ' + esc(emailCode.subject) : "";
        return '<div class="registration-email-code">' +
          '<div class="registration-email-code-head"><strong>邮箱验证码（自动查询，仅显示）</strong><span class="registration-phone-order-source">' + refreshButton + '<span class="tag' + statusClass + '">' + esc(phaseLabel) + '</span></span></div>' +
          '<div class="registration-email-code-grid">' +
            '<div class="registration-email-code-result"><label>最新邮箱验证码</label><strong>' + esc(code || "— — —") + '</strong>' + copyButton + '</div>' +
            '<div class="registration-email-code-result"><label>邮件收到时间</label><strong>' + esc(receivedAt ? formatDate(receivedAt) : "— — —") + '</strong></div>' +
          '</div>' +
          '<div class="field-note" aria-live="polite">' + esc(emailCode.message || "注册开始后自动查询最近 30 分钟的邮件") + detail + '</div>' +
          (emailCode.error ? '<div class="tag error" style="margin-top:8px">' + esc(emailCode.error) + '</div>' : "") +
        '</div>';
      }

      function renderRegistrationInputs(session) {
        const values = registrationInputValues[session.id] || {};
        const terminal = ["completed", "failed", "cancelled"].includes(session.state);
        if (session.mode === "oauth") {
          const actionHtml = terminal
            ? '<div class="registration-session-actions"><button type="button" data-action="registration-cleanup" data-session-id="' + esc(session.id) + '">清除记录</button></div>'
            : '<div class="registration-session-actions"><button type="button" data-action="registration-cancel" data-session-id="' + esc(session.id) + '">取消 OAuth 流程</button></div>';
          return '<div class="field-note">请在已打开的 Codex OAuth 浏览器窗口中完成当前页面。邮箱验证码和接码平台内容仍可在本面板查看并复制，但不会提交到外部浏览器。</div>' + actionHtml;
        }
        const emailCodeReady = session.state === "awaiting_email_code";
        const phoneReady = session.state === "awaiting_phone_input";
        const otpReady = session.state === "awaiting_otp_input";
        const authorizationReady = session.state === "awaiting_authorization";
        const inputDisabled = terminal ? " disabled" : "";
        const emailCodeSubmitDisabled = emailCodeReady ? "" : " disabled";
        const phoneSubmitDisabled = phoneReady ? "" : " disabled";
        const otpSubmitDisabled = otpReady ? "" : " disabled";
        const newPhoneDisabled = phoneReady || otpReady ? "" : " disabled";
        const recognizedEmailCode = String(session.emailCode?.code || "").trim();
        const rawRecognizedPhone = String(session.phoneOrder?.order?.phone || "").trim();
        const recognizedPhone = isCompletePhoneNumber(rawRecognizedPhone) ? rawRecognizedPhone : "";
        const recognizedOtp = String(session.phoneOrder?.order?.smsCode || "").trim();
        const autoFillButton = (action, value, label) => value
          ? '<button type="button" data-action="' + action + '" data-session-id="' + esc(session.id) + '" data-value="' + esc(value) + '">' + label + '</button>'
          : '<button type="button" disabled>无可用内容</button>';
        const actionHtml = terminal
          ? '<div class="registration-session-actions"><button type="button" data-action="registration-cleanup" data-session-id="' + esc(session.id) + '">清除记录</button></div>'
          : '<div class="registration-session-actions">' +
            '<button type="button" data-action="registration-submit-email-code" data-session-id="' + esc(session.id) + '"' + emailCodeSubmitDisabled + '>提交邮箱验证码</button>' +
            '<button type="button" data-action="registration-submit-phone" data-session-id="' + esc(session.id) + '"' + phoneSubmitDisabled + '>提交号码</button>' +
            '<button type="button" data-action="registration-submit-otp" data-session-id="' + esc(session.id) + '"' + otpSubmitDisabled + '>提交验证码</button>' +
            (authorizationReady ? '<button type="button" class="primary" data-action="registration-authorize" data-session-id="' + esc(session.id) + '">确认授权并完成</button>' : '') +
            '<button type="button" data-action="registration-request-new-phone" data-session-id="' + esc(session.id) + '"' + newPhoneDisabled + '>手动重新填写号码</button>' +
            '<button type="button" data-action="registration-cancel" data-session-id="' + esc(session.id) + '">取消</button>' +
          '</div>';
        return '<div class="registration-session-input"><label for="emailCodeInput-' + esc(session.id) + '">邮箱验证码（请确认后提交）</label><div class="registration-input-with-action"><input type="text" id="emailCodeInput-' + esc(session.id) + '" value="' + esc(values.emailCode || "") + '" placeholder="从上方识别结果复制或手动填写" autocomplete="one-time-code"' + inputDisabled + '>' + autoFillButton("registration-fill-email-code", recognizedEmailCode, "自动填入邮箱码") + '</div></div>' +
        '<div class="registration-credential-grid">' +
          '<div class="registration-session-input"><label for="phoneInput-' + esc(session.id) + '">手机号（请确认后提交）</label><div class="registration-input-with-action"><input type="text" id="phoneInput-' + esc(session.id) + '" value="' + esc(values.phone || "") + '" placeholder="+86 138..." autocomplete="off"' + inputDisabled + '>' + autoFillButton("registration-fill-phone", recognizedPhone, "自动填入手机号") + '</div></div>' +
          '<div class="registration-session-input"><label for="otpInput-' + esc(session.id) + '">短信验证码（请确认后提交）</label><div class="registration-input-with-action"><input type="text" id="otpInput-' + esc(session.id) + '" value="' + esc(values.otp || "") + '" placeholder="6 位数字" autocomplete="off"' + inputDisabled + '>' + autoFillButton("registration-fill-code", recognizedOtp, "自动填入短信码") + '</div></div>' +
        '</div>' +
        '<div class="field-note">进度会根据注册页面实时状态更新。自动填入按钮只把识别内容填入面板输入框；邮箱码、手机号、短信码和最后继续/授权仍需你点击对应确认按钮。</div>' +
        actionHtml;
      }

      function renderPhoneOrder(session) {
        const orderState = session.phoneOrder || { phase: "idle", running: false, replacements: 0, maxReplacements: 10 };
        const order = orderState.order || {};
        const phone = String(order.phone || "").trim();
        const code = String(order.smsCode || "").trim();
        const phase = String(orderState.phase || "idle");
        const active = orderState.running === true;
        const canReplace = active && ["waiting", "polling"].includes(phase) && !code && Number(orderState.replacements || 0) < Number(orderState.maxReplacements || 0);
        const canCancel = active && !["received", "completed", "cancelled", "error", "timed_out"].includes(phase);
        const sources = Array.isArray(state.phoneSources) && state.phoneSources.length
          ? state.phoneSources
          : [{ id: "liye", displayName: "LIYE", websiteUrl: "https://liye.5x20.cn" }];
        const storedSourceId = registrationPhoneSourceSelections[session.id] || orderState.card?.source || sources[0].id;
        const source = sources.find((item) => item.id === storedSourceId) || sources[0];
        registrationPhoneSourceSelections[session.id] = source.id;
        const keyPool = state.registrationKeyPool || { keys: [], available: 0, inUse: 0, count: 0 };
        const keys = Array.isArray(keyPool.keys) ? keyPool.keys : [];
        const availableKeys = keys.filter((key) => key.status === "available");
        const storedKeyId = registrationPhoneKeySelections[session.id] || orderState.card?.keyId || "";
        const storedKey = keys.find((key) => key.id === storedKeyId);
        const selectedKeyId = active && storedKey?.status === "in_use"
          ? storedKey.id
          : availableKeys.some((key) => key.id === storedKeyId)
            ? storedKeyId
            : availableKeys[0]?.id || "";
        if (selectedKeyId) registrationPhoneKeySelections[session.id] = selectedKeyId;
        else delete registrationPhoneKeySelections[session.id];
        const visibleKeys = [
          ...(selectedKeyId ? keys.filter((key) => key.id === selectedKeyId) : []),
          ...availableKeys.filter((key) => key.id !== selectedKeyId)
        ].slice(0, 5);
        const sourceOptions = sources.map((item) => '<option value="' + esc(item.id) + '" ' + (item.id === source.id ? "selected" : "") + '>' + esc(item.displayName || item.id) + '</option>').join("");
        const selectedKey = keys.find((key) => key.id === selectedKeyId);
        const selectedKeyAvailable = selectedKey?.status === "available";
        const keyOptions = visibleKeys.length
          ? visibleKeys.map((key) => '<option value="' + esc(key.id) + '" ' + (key.id === selectedKeyId ? "selected" : "") + (key.status === "in_use" ? " disabled" : "") + '>' + esc(key.masked || key.id) + (key.status === "in_use" ? "（使用中）" : "") + '</option>').join("")
          : '<option value="">暂无 Key，请先添加</option>';
        const hiddenAvailableKeyCount = Math.max(0, availableKeys.length - visibleKeys.filter((key) => key.status === "available").length);
        const keyVisibilityNote = hiddenAvailableKeyCount > 0
          ? '<div class="field-note">可用 Key 共 ' + availableKeys.length + ' 个，选择器仅显示前 5 个；其余仍保留在 Key 池中。</div>'
          : "";
        const configDisabled = active ? " disabled" : "";
        const keyInput = registrationPhoneKeyInputs[session.id] || "";
        const canAcquire = !active && !["received", "completed"].includes(phase);
        const keyPoolDetails = '<details class="registration-key-pool"><summary>管理接码 Key 池 <span class="registration-key-pool-count">' + Number(keyPool.available || 0) + ' 个可用 · ' + Number(keyPool.inUse || 0) + ' 个使用中</span></summary>' +
          (!active ? '<div class="registration-session-input"><label for="registrationPhoneKeyInput-' + esc(session.id) + '">加入 Key 池（可多行粘贴）</label><textarea id="registrationPhoneKeyInput-' + esc(session.id) + '" rows="2" autocomplete="off" spellcheck="false" placeholder="每行一个接码平台 Key">' + esc(keyInput) + '</textarea><button type="button" class="secondary small" data-action="registration-add-phone-key" data-session-id="' + esc(session.id) + '">加入 Key 池</button></div>' : '') +
          (keys.length ? '<div class="registration-key-pool-list" aria-label="接码平台 Key 池">' + keys.map((key) => '<div class="registration-key-pool-row"><span class="key-mask" title="仅显示脱敏值">' + esc(key.masked || key.id) + '</span><span>' + esc(key.status === "in_use" ? "使用中" : "可用") + '</span><button type="button" class="secondary small" data-action="registration-remove-phone-key" data-key-id="' + esc(key.id) + '"' + (key.status === "in_use" ? " disabled" : "") + '>删除</button></div>').join("") + '</div>' : '<div class="field-note">暂未保存 Key。展开后可粘贴添加。</div>') +
          '</details>';
        const acquireHtml = '<div class="registration-phone-config">' +
          '<div class="field"><label for="registrationPhoneSource-' + esc(session.id) + '">接码来源</label><select id="registrationPhoneSource-' + esc(session.id) + '"' + configDisabled + '>' + sourceOptions + '</select></div>' +
          '<div class="field"><label for="registrationPhoneKey-' + esc(session.id) + '">选择 Key（SecretStorage）</label><select id="registrationPhoneKey-' + esc(session.id) + '"' + configDisabled + '><option value="">请选择 Key</option>' + keyOptions + '</select>' + keyVisibilityNote + '</div>' +
        '</div>' +
        keyPoolDetails +
        (!active && !selectedKeyAvailable ? '<div class="field-note">请选择一个可用 Key，再开始取号。</div>' : "");
        const phoneButton = isCompletePhoneNumber(phone)
          ? '<button type="button" class="secondary small" data-action="registration-copy-phone" data-session-id="' + esc(session.id) + '" data-value="' + esc(phone) + '">复制手机号</button>'
          : '<button type="button" class="secondary small" disabled>等待完整手机号</button>';
        const codeButton = code
          ? '<button type="button" class="secondary small" data-action="registration-copy-code" data-session-id="' + esc(session.id) + '" data-value="' + esc(code) + '">复制验证码</button>'
          : '<button type="button" class="secondary small" disabled>复制验证码</button>';
        const statusClass = ["received", "completed"].includes(phase) ? " success" : ["error", "timed_out"].includes(phase) ? " error" : "";
        const countdownStartedAt = Number(orderState.startedAt || 0);
        const countdownTimeout = Number(orderState.orderTimeoutMs || 0);
        const countdown = countdownStartedAt && countdownTimeout ? formatRemainingDuration(Math.max(0, countdownStartedAt + countdownTimeout - Date.now())) : "—";
        const replaceCountdown = formatUntil(order.replaceAvailableAt);
        const cancelCountdown = formatUntil(order.cancelAvailableAt);
        const orderWindow = countdownStartedAt && countdownTimeout
          ? '<span class="registration-countdown">本轮剩余 <strong data-registration-countdown data-started-at="' + countdownStartedAt + '" data-timeout-ms="' + countdownTimeout + '">' + countdown + '</strong></span>'
          : '<span class="registration-countdown">本轮剩余 —</span>';
        const availability = [replaceCountdown ? "换号 " + replaceCountdown : "", cancelCountdown ? "取消 " + cancelCountdown : ""].filter(Boolean).join(" · ");
        const sourceLink = source.websiteUrl
          ? '<a href="' + esc(source.websiteUrl) + '" target="_blank" rel="noreferrer">打开接码网页</a>'
          : "";
        const successRate = formatPhoneSuccessRate(orderState.card?.successRate);
        const actionHtml = '<div class="registration-phone-order-actions">' +
          '<button type="button" class="secondary" data-action="registration-replace-phone" data-session-id="' + esc(session.id) + '"' + (canReplace ? "" : " disabled") + '>重新取号</button>' +
          '<button type="button" class="secondary danger" data-action="registration-cancel-phone" data-session-id="' + esc(session.id) + '"' + (canCancel ? "" : " disabled") + '>取消取号</button>' +
          (canAcquire ? '<button type="button" class="primary" data-action="registration-acquire-phone" data-session-id="' + esc(session.id) + '"' + (selectedKeyAvailable ? "" : " disabled") + '>开始取号</button>' : '') +
          '</div>';
        return '<div class="registration-phone-order">' +
          '<div class="registration-phone-order-head"><strong>接码平台（自动读取短信）</strong><span class="registration-phone-order-source">' + sourceLink + '<span class="registration-phone-success-rate">' + esc(source.displayName || source.id || "平台") + ' 成功率：' + esc(successRate) + '</span>' + orderWindow + '<span class="tag' + statusClass + '">' + esc(PHONE_ORDER_PHASE_LABELS[phase] || phase) + '</span></span></div>' +
          acquireHtml +
          '<div class="registration-phone-order-grid">' +
            '<div class="registration-phone-result"><label>当前手机号</label><strong>' + esc(phone || "— — —") + '</strong>' + phoneButton + '</div>' +
            '<div class="registration-phone-result"><label>验证码</label><strong>' + esc(code || "— — —") + '</strong>' + codeButton + '</div>' +
          '</div>' +
          '<div class="field-note">手机号和验证码只显示/复制，不会自动填写或提交到注册页面；拿到号码后会自动读取验证码，换号和取消仍需你点击。' + (availability ? " · " + availability : "") + '</div>' +
          actionHtml +
          (orderState.message ? '<div class="field-note" aria-live="polite">' + esc(orderState.message) + '</div>' : "") +
          (orderState.error ? '<div class="tag" style="margin-top:8px;color:var(--danger)">' + esc(orderState.error) + '</div>' : "") +
        '</div>';
      }

      function renderLayout() {
        const allMailboxes = state.mailboxes || [];
        const filteredMailboxes = filterMailboxes();
        const sortedMailboxes = [...filteredMailboxes].sort(compareMailboxes);
        const query = mailboxSearch.trim().toLowerCase();
        const codexFilterAvailable = state.codexImportAvailable === true;
        const selectedHasRenewal = [...selectedMailboxIds].some((mailboxId) => {
          const mailbox = allMailboxes.find((item) => item.id === mailboxId);
          return state.providers?.find((provider) => provider.id === mailbox?.providerId)?.capabilities?.manualRenewal === true;
        });
        const selectedHasActiveOperation = (state.operations || []).some((operation) => selectedMailboxIds.has(operation.mailboxId));
        const rows = sortedMailboxes.length
          ? sortedMailboxes.map((mailbox, index) => renderMailboxRow(mailbox, index)).join("")
          : '<div class="empty-list">' + (allMailboxes.length ? '没有匹配的邮箱。' : '还没有邮箱。<br>点击“添加邮箱”并在导入时选择来源。') + '</div>';
        const selected = state.selected;
        const filterActive = Boolean(query || providerFilter || onlyUnlinkedCodex);
        const providerOptions = (state.providers || []).map((provider) => '<option value="' + esc(provider.id) + '" ' + (providerFilter === provider.id ? "selected" : "") + '>' + esc(provider.displayName || provider.id) + '（' + esc(provider.id) + '）</option>').join("");
        return '<div class="layout">' +
          '<section class="box"><div class="box-header mailbox-list-header"><div><h2>邮箱列表</h2><p class="muted">输入邮箱前缀实时筛选 · 完整地址作为标识</p></div><span class="tag">' + (filterActive ? sortedMailboxes.length + '/' : '') + allMailboxes.length + '</span></div><div class="mailbox-list-toolbar"><div class="mailbox-list-tools"><input id="mailboxSearch" type="search" value="' + esc(mailboxSearch) + '" placeholder="输入邮箱前缀实时筛选" aria-label="按邮箱前缀搜索"><select id="mailboxProviderFilter" aria-label="按邮箱来源筛选"><option value="">全部来源</option>' + providerOptions + '</select><select id="mailboxSort" aria-label="邮箱排序"><option value="nameAsc" ' + (mailboxSort === "nameAsc" ? "selected" : "") + '>名称升序</option><option value="nameDesc" ' + (mailboxSort === "nameDesc" ? "selected" : "") + '>名称降序</option><option value="queryDesc" ' + (mailboxSort === "queryDesc" ? "selected" : "") + '>最近查询</option><option value="codeFirst" ' + (mailboxSort === "codeFirst" ? "selected" : "") + '>已出码优先</option></select><label title="' + (codexFilterAvailable ? '依据当前 Manager 已接入账号目录判断' : '当前 Manager 未提供账号目录') + '"><input id="onlyUnlinkedCodex" type="checkbox" ' + (onlyUnlinkedCodex ? "checked" : "") + (codexFilterAvailable ? "" : " disabled") + '> 仅未接入 Codex</label></div><div class="selection-tools"><span>已选 ' + selectedMailboxIds.size + ' / ' + sortedMailboxes.length + '</span><span><button type="button" data-action="select-visible">全选当前结果</button><button type="button" data-action="clear-selection">清空选择</button></span></div><div class="batch-tools"><button type="button" data-action="batch-query" ' + (selectedMailboxIds.size && !pendingBatchAction ? "" : "disabled") + '>批量查询</button><button type="button" data-action="batch-wait" ' + (selectedMailboxIds.size && !pendingBatchAction ? "" : "disabled") + '>批量监听</button><button type="button" data-action="batch-renewal" ' + (selectedHasRenewal && !pendingBatchAction ? "" : "disabled") + '>批量续期</button><button type="button" data-action="batch-stop" ' + (selectedMailboxIds.size && selectedHasActiveOperation && !pendingBatchAction ? "" : "disabled") + '>批量停止</button><button type="button" class="danger" data-action="batch-delete" ' + (selectedMailboxIds.size && !pendingBatchAction ? "" : "disabled") + '>批量删除</button></div></div><div class="mailbox-list">' + rows + '</div></section>' +
          '<section class="box detail">' + (selected ? renderSelected(selected) : '<div class="empty-detail"><div><h2>选择一个邮箱</h2><p class="muted" style="margin-top:8px">其他邮箱的邮件详情不会在未选中时渲染或查询。</p></div></div>') + '</section>' +
          '</div>';
      }

      function compareMailboxes(left, right) {
        if (mailboxSort === "queryDesc") return (right.lastQueryAt || 0) - (left.lastQueryAt || 0) || compareText(left, right);
        if (mailboxSort === "codeFirst") return Number(Boolean(right.latestCode)) - Number(Boolean(left.latestCode)) || compareText(left, right);
        const result = compareText(left, right);
        return mailboxSort === "nameDesc" ? -result : result;
      }

      function compareText(left, right) {
        return String(left.displayName || left.address || "").localeCompare(String(right.displayName || right.address || ""), "zh-CN", { numeric: true, sensitivity: "base" }) || String(left.address || "").localeCompare(String(right.address || ""), "en", { numeric: true, sensitivity: "base" });
      }

      function matchesMailboxSearch(mailbox, query) {
        const address = String(mailbox.address || "").trim().toLowerCase();
        const localPart = address.split("@", 1)[0];
        const displayName = String(mailbox.displayName || "").trim().toLowerCase();
        const providerId = String(mailbox.providerId || "").trim().toLowerCase();
        return localPart.startsWith(query) || address.startsWith(query) || displayName.includes(query) || providerId.includes(query);
      }

      function filterMailboxes() {
        const query = mailboxSearch.trim().toLowerCase();
        return (state.mailboxes || []).filter((mailbox) => {
          if (query && !matchesMailboxSearch(mailbox, query)) return false;
          if (providerFilter && mailbox.providerId !== providerFilter) return false;
          if (onlyUnlinkedCodex && (!state.codexImportAvailable || isCodexLinked(mailbox))) return false;
          return true;
        });
      }

      function renderMailboxRow(mailbox, index) {
        const active = (state.operations || []).find((operation) => operation.mailboxId === mailbox.id);
        const pending = pendingActions[mailbox.id] || (pendingCodexImports[mailbox.id] ? "codexImport" : "");
        const status = active ? active.kind === "wait" ? "监听中" : active.kind === "renewal" ? "续期中" : "查询中" : mailbox.lastStatus || "未查询";
        const statusClass = mailbox.lastStatus === "error" ? "error" : mailbox.latestCode ? "success" : "";
        const codexLinked = isCodexLinked(mailbox);
        const mailboxError = mailbox.lastError ? '<span class="tag error" title="' + esc(mailbox.lastError.message || "查询失败") + '">' + esc(mailbox.lastError.code || "查询失败") + '：' + esc(mailbox.lastError.message || "查询失败") + '</span>' : '';
        return '<div class="mailbox-row-wrap"><label class="mailbox-select"><input class="mailbox-checkbox" type="checkbox" value="' + esc(mailbox.id) + '" ' + (selectedMailboxIds.has(mailbox.id) ? "checked" : "") + ' aria-label="选择 ' + esc(mailbox.address) + '"></label><button class="mailbox-row ' + (state.selectedMailboxId === mailbox.id ? "selected" : "") + '" data-action="select-mailbox" data-mailbox-id="' + esc(mailbox.id) + '">' +
          '<div class="row-title"><span class="row-number">' + (index + 1) + '</span><span class="address">' + esc(mailbox.displayName || mailbox.address) + '</span></div>' +
          '<div class="row-meta"><span class="address">' + esc(mailbox.address) + '</span><span class="tag">' + esc(mailbox.providerId) + '</span><span class="tag ' + statusClass + '">' + esc(status) + '</span>' +
          (state.codexImportAvailable ? '<span class="tag ' + (codexLinked ? 'success' : 'warning') + '">' + (codexLinked ? 'Codex 已接入' : '未接入 Codex') + '</span>' : '') +
          (mailbox.latestCode ? '<span class="tag success">验证码 ' + esc(mailbox.latestCode) + '</span>' : '') + (mailbox.lastError ? '<span class="tag error" title="' + esc(mailbox.lastError.message || "查询失败") + '">' + esc(mailbox.lastError.code || "查询失败") + '</span>' : '') + '</div></button><div class="mailbox-row-actions"><button class="mailbox-row-action ' + (pending === "edit" ? 'is-pending' : '') + '" data-action="edit-mailbox" data-mailbox-id="' + esc(mailbox.id) + '" title="编辑邮箱" ' + (pending ? 'disabled' : '') + '>' + (pending === "edit" ? '<span class="button-spinner" aria-hidden="true"></span>' : '') + '编辑</button><button class="mailbox-row-action danger ' + (pending === "delete" ? 'is-pending' : '') + '" data-action="delete-mailbox" data-mailbox-id="' + esc(mailbox.id) + '" title="删除邮箱" ' + (pending ? 'disabled' : '') + '>' + (pending === "delete" ? '<span class="button-spinner" aria-hidden="true"></span>' : '') + '删除</button></div></div>';
      }

      function renderSelected(selected) {
        const mailbox = selected.mailbox;
        const detail = selected.detail || { messages: [], codes: [] };
        const operation = (state.operations || []).find((item) => item.mailboxId === mailbox.id);
        const messages = detail.messages || [];
        const provider = (state.providers || []).find((item) => item.id === mailbox.providerId);
        const capability = provider?.capabilities?.history === "latest" ? "最近 1 封" : '最近 ' + (provider?.capabilities?.maxMessages || 10) + ' 封';
        const requestedAction = pendingActions[mailbox.id] || "";
        const codexImportPending = Boolean(pendingCodexImports[mailbox.id]);
        const busyAction = requestedAction && requestedAction !== "codexImport"
          ? requestedAction
          : (operation?.kind || "");
        const canStop = Boolean(
          operation ||
          (codexImportPending && state.codexImportCancellable) ||
          requestedAction === "stop"
        );
        const codexLinked = isCodexLinked(mailbox);
        const mailboxError = mailbox.lastError ? '<span class="tag error" title="' + esc(mailbox.lastError.message || "查询失败") + '">' + esc(mailbox.lastError.code || "查询失败") + '：' + esc(mailbox.lastError.message || "查询失败") + '</span>' : '';
        const actionLabel = (action, label) => busyAction === action ? '<span class="button-spinner" aria-hidden="true"></span>' + ({ query: "查询中…", wait: "监听中…", renewal: "续期中…", stop: "停止中…", codexImport: "导入中…" }[action] || label) : label;
        const codexImportButton = state.codexImportAvailable && !codexLinked
          ? '<button class="primary ' + (codexImportPending ? 'is-pending' : '') + '" data-action="codex-import" data-mailbox-id="' + esc(mailbox.id) + '" ' + ((codexImportPending || operation || (requestedAction && !codexImportPending)) ? 'disabled' : '') + ' aria-busy="' + codexImportPending + '">' + (codexImportPending ? '<span class="button-spinner" aria-hidden="true"></span>导入中…' : 'Codex 导入') + '</button>'
          : '';
        return '<div class="detail-header"><div class="detail-address">' + esc(mailbox.address) + '</div><div class="detail-name">' + esc(mailbox.displayName || mailbox.address) + '</div><div class="detail-meta"><span class="tag">来源：' + esc(provider?.displayName || mailbox.providerId) + '</span><span class="tag">' + capability + '</span><span class="tag">' + (provider?.capabilities?.manualRenewal ? '支持人工续期' : '不支持续期') + '</span>' + mailboxError + '</div></div>' +
          '<div class="detail-header-actions">' + codexImportButton + '<button data-action="edit-mailbox" data-mailbox-id="' + esc(mailbox.id) + '">编辑账号</button><button class="danger" data-action="delete-mailbox" data-mailbox-id="' + esc(mailbox.id) + '">删除账号</button></div>' +
          '<div class="detail-actions"><div class="actions">' +
          '<button class="' + (busyAction === "query" ? 'is-pending' : '') + '" data-action="submit-query" ' + (busyAction ? 'disabled' : '') + ' aria-busy="' + (busyAction === "query") + '">' + actionLabel("query", "查询邮件") + '</button>' +
          '<button class="primary ' + (busyAction === "wait" ? 'is-pending' : '') + '" data-action="submit-wait" ' + (busyAction ? 'disabled' : '') + ' aria-busy="' + (busyAction === "wait") + '">' + actionLabel("wait", "接收验证码") + '</button>' +
          '<button class="' + (busyAction === "renewal" ? 'is-pending' : '') + '" data-action="submit-renewal" ' + (busyAction || !provider?.capabilities?.manualRenewal ? 'disabled' : '') + ' aria-busy="' + (busyAction === "renewal") + '">' + actionLabel("renewal", "人工续期") + '</button>' +
          '<button data-action="stop" class="danger ' + (busyAction === "stop" ? 'is-pending' : '') + '" ' + (canStop ? '' : 'disabled') + ' aria-busy="' + (busyAction === "stop") + '">' + actionLabel("stop", "停止") + '</button>' +
          '</div></div>' +
          '<div class="content"><div class="hero"><div><div class="hero-label">最近一次验证码</div><div class="code">' + esc(detail.codes?.[0] || mailbox.latestCode || '—') + '</div><div class="muted">' + (detail.fetchedAt ? '查询于 ' + esc(formatDate(detail.fetchedAt)) : '尚未查询该邮箱') + '</div></div><div class="hero-side">' + (detail.codes?.[0] ? '<button class="primary" data-action="copy-code" data-code="' + esc(detail.codes[0]) + '">复制验证码</button>' : '') + '</div></div>' +
          '<div class="section-title"><h2>邮件</h2><span class="muted">' + esc(capability) + '</span></div>' +
          (messages.length ? '<div class="messages">' + messages.map(renderMessageEntry).join("") + '</div>' : '<div class="empty-detail" style="min-height:180px">暂无邮件结果。手动启动一次查询或验证码接收流程。</div>') + '</div>';
      }

      function renderMessageRow(message) {
        const selected = message.id === selectedMessageId;
        return '<button class="message-row ' + (selected ? 'selected' : '') + '" data-action="select-message" data-message-id="' + esc(message.id) + '" aria-expanded="' + selected + '"><div class="message-subject">' + esc(message.subject) + '</div><div class="message-time">' + esc(formatDate(message.receivedAt)) + (message.codes?.length ? ' · 验证码 ' + esc(message.codes.join('/')) : '') + '</div></button>';
      }

      function renderMessageEntry(message) {
        return '<div class="message-entry">' + renderMessageRow(message) + (message.id === selectedMessageId ? '<article class="message-detail">' + renderMessageDetail(message) + '</article>' : '') + '</div>';
      }

      function renderMessageDetail(message) {
        if (!message) return '<p class="muted">选择一封邮件查看详情。</p>';
        const sender = [message.senderName, message.from].filter(Boolean).join(' <') + (message.from && message.senderName ? '>' : '');
        return '<h3>' + esc(message.subject) + '</h3><div class="from">发件人：' + esc(sender || '未知') + '</div><div class="from">时间：' + esc(formatDate(message.receivedAt)) + '</div>' + (message.codes?.length ? '<div class="detail-meta">' + message.codes.map((code) => '<span class="tag success">验证码 ' + esc(code) + '</span>').join('') + '</div>' : '') + '<div class="body">' + esc(message.body || message.preview || '无正文') + '</div>';
      }

      function normalizeEmail(value) {
        return String(value || "").trim().toLowerCase();
      }

      function isCompletePhoneNumber(value) {
        const compact = String(value || "").trim().replace(/[\\s()\\-]/gu, "");
        if (!/^\\+?\\d+$/u.test(compact)) return false;
        const digits = compact.replace(/^\\+/u, "");
        if (digits.startsWith("86")) return /^861\\d{10}$/u.test(digits);
        if (/^1\\d{10}$/u.test(digits)) return true;
        return digits.length >= 10 && digits.length <= 15;
      }

      function hasManagedCodexEmail(address) {
        const normalized = normalizeEmail(address);
        return Boolean(normalized) && (state.managedAccountEmails || []).some((email) => normalizeEmail(email) === normalized);
      }

      function isCodexLinked(mailbox) {
        return hasManagedCodexEmail(mailbox.address);
      }

      function renderImportModal() {
        const providers = state.providers || [];
        const provider = providers.find((item) => item.id === importProvider) || providers[0];
        if (!provider) {
          return '<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>添加邮箱</h2><p class="muted">邮箱来源正在加载，请稍候；加载完成后此窗口会自动更新。</p><div class="modal-actions"><button type="button" data-action="close-import">关闭</button></div></section></div>';
        }
        const schema = provider.importSchema || {};
        const description = schema.description || "来源决定导入和查询协议。";
        const placeholder = schema.placeholder || "粘贴所选邮箱来源的凭据";
        return '<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>添加邮箱</h2><form id="importForm"><div class="field"><label for="providerId">邮箱来源 / 格式</label><select id="providerId" name="providerId">' + (state.providers || []).map((item) => '<option value="' + esc(item.id) + '" ' + (item.id === provider.id ? 'selected' : '') + '>' + esc(item.displayName) + '（' + esc(item.id) + '）</option>').join('') + '</select><div class="field-note">来源决定导入和查询协议。</div></div><div class="field"><label for="displayName">显示名称（可选）</label><input id="displayName" name="displayName" placeholder="可选显示名称"></div><div class="field"><label for="input">来源凭据</label><textarea id="input" name="input" required placeholder="' + esc(placeholder) + '"></textarea><div class="field-note">' + esc(description) + '</div></div><div class="modal-actions"><button type="button" data-action="close-import">取消</button><button class="primary" type="submit">导入并加入列表</button></div></form></section></div>';
      }

      function renderEditModal() {
        const mailbox = (state.mailboxes || []).find((item) => item.id === editOpenMailboxId);
        if (!mailbox) return '';
        const provider = (state.providers || []).find((item) => item.id === editProvider) || (state.providers || []).find((item) => item.id === mailbox.providerId);
        const schema = provider?.importSchema || {};
        const placeholder = schema.placeholder || "所选来源的单行凭据";
        return '<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>编辑邮箱</h2><p class="muted">' + esc(mailbox.address) + '</p><form id="editForm"><div class="field"><label for="editProviderId">邮箱来源 / 格式</label><select id="editProviderId" name="providerId">' + (state.providers || []).map((item) => '<option value="' + esc(item.id) + '" ' + (item.id === provider?.id ? 'selected' : '') + '>' + esc(item.displayName) + '（' + esc(item.id) + '）</option>').join('') + '</select></div><div class="field"><label for="displayName">显示名称</label><input id="displayName" name="displayName" value="' + esc(mailbox.displayName || mailbox.address) + '" required></div><div class="field"><label for="input">替换来源凭据（可选）</label><textarea id="input" name="input" placeholder="留空只修改显示名称；填写时请输入：' + esc(placeholder) + '"></textarea><div class="field-note">当前凭据不会回显。切换邮箱来源 / 格式时必须填写凭据；邮箱地址保持不变。</div></div><div class="modal-actions"><button type="button" data-action="close-edit">取消</button><button class="primary" type="submit">保存修改</button></div></form></section></div>';
      }

      function clearRegistrationSessionClientState(sessionId) {
        if (!sessionId) return;
        delete registrationInputValues[sessionId];
        delete registrationPhoneKeyInputs[sessionId];
        delete registrationPhoneSourceSelections[sessionId];
        delete registrationPhoneKeySelections[sessionId];
      }

      function formatRemainingDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
      }

      function formatPhoneSuccessRate(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return "平台未提供";
        return (parsed % 1 ? parsed.toFixed(1) : parsed.toFixed(0)) + "%";
      }

      function timestampValue(value) {
        if (typeof value === "number" || (/^\d+(?:\.\d+)?$/u.test(String(value || "").trim()) && String(value || "").trim())) {
          const number = Number(value);
          return number > 0 && number < 1e12 ? number * 1000 : number;
        }
        const parsed = Date.parse(String(value || ""));
        return Number.isFinite(parsed) ? parsed : 0;
      }

      function formatUntil(value) {
        const timestamp = timestampValue(value);
        if (!timestamp) return "";
        const remaining = timestamp - Date.now();
        return remaining <= 0 ? "可用" : formatRemainingDuration(remaining);
      }

      function updateRegistrationCountdowns() {
        const elements = document.querySelectorAll("[data-registration-countdown]");
        for (const element of elements) {
          const startedAt = Number(element.dataset.startedAt || 0);
          const timeoutMs = Number(element.dataset.timeoutMs || 0);
          element.textContent = startedAt && timeoutMs
            ? formatRemainingDuration(Math.max(0, startedAt + timeoutMs - Date.now()))
            : "—";
        }
      }

      function ensureRegistrationCountdownTimer() {
        if (registrationCountdownTimer || typeof setInterval !== "function") return;
        registrationCountdownTimer = setInterval(() => {
          const elements = document.querySelectorAll("[data-registration-countdown]");
          if (!elements.length) {
            clearInterval(registrationCountdownTimer);
            registrationCountdownTimer = undefined;
            return;
          }
          updateRegistrationCountdowns();
        }, 1000);
      }

      async function copyCode(code) {
        await copyText(code, "验证码已复制");
      }
      function copyText(value, successMessage) {
        if (!value) return;
        send("copyText", { text: value, successMessage: successMessage || "已复制" });
      }

      function updateRegistrationAcquireButton(sessionId) {
        const keys = Array.isArray(state.registrationKeyPool?.keys) ? state.registrationKeyPool.keys : [];
        const selectedKeyId = registrationPhoneKeySelections[sessionId] || "";
        const selectedKey = keys.find((key) => key.id === selectedKeyId);
        const enabled = selectedKey?.status === "available";
        document.querySelectorAll('[data-action="registration-acquire-phone"]').forEach((button) => {
          if (button.dataset.sessionId === sessionId) button.disabled = !enabled;
        });
      }

      function fillRegistrationInput(sessionId, field, value) {
        if (!sessionId || !value) return;
        const inputId = field === "emailCode" ? "emailCodeInput-" + sessionId : field === "phone" ? "phoneInput-" + sessionId : "otpInput-" + sessionId;
        const input = document.getElementById(inputId);
        if (!input || input.disabled) return;
        input.value = value;
        registrationInputValues[sessionId] = { ...(registrationInputValues[sessionId] || {}), [field]: value };
        if (typeof Event === "function" && typeof input.dispatchEvent === "function") {
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.focus();
        showNotice("已填入识别内容，请检查后点击提交", "success");
      }

      function openEditModal(mailboxId) {
        if (!(state.mailboxes || []).some((mailbox) => mailbox.id === mailboxId)) return;
        importOpen = false;
        editOpenMailboxId = mailboxId;
        editProvider = (state.mailboxes || []).find((mailbox) => mailbox.id === mailboxId)?.providerId || "";
        render();
      }

      function requestDelete(mailboxId) {
        const mailbox = (state.mailboxes || []).find((item) => item.id === mailboxId);
        if (!mailbox) return;
        importOpen = false;
        editOpenMailboxId = "";
        deleteConfirm = { kind: "single", mailboxId, address: mailbox.address };
        render();
      }

      function requestAction(action, mailboxId) {
        if (!mailboxId) return;
        pendingActions[mailboxId] = action;
        render();
        send(action, { mailboxId });
      }

      function toggleMailboxSelection(mailboxId, checked) {
        if (!mailboxId) return;
        if (checked === false || (checked === undefined && selectedMailboxIds.has(mailboxId))) selectedMailboxIds.delete(mailboxId);
        else selectedMailboxIds.add(mailboxId);
        render();
      }

      function getVisibleMailboxes() {
        return filterMailboxes().sort(compareMailboxes);
      }

      function selectVisibleMailboxes() {
        for (const mailbox of getVisibleMailboxes()) selectedMailboxIds.add(mailbox.id);
        render();
      }

      function requestBatchAction(action) {
        const mailboxIds = [...selectedMailboxIds];
        if (!mailboxIds.length) return;
        pendingBatchAction = action;
        render();
        send(action, { mailboxIds });
      }

      function requestBatchDelete() {
        const mailboxIds = [...selectedMailboxIds];
        if (!mailboxIds.length) return;
        deleteConfirm = { kind: "batch", mailboxIds };
        render();
      }

      function confirmDelete() {
        const request = deleteConfirm;
        if (!request) return;
        deleteConfirm = undefined;
        if (request.kind === "single") {
          pendingActions[request.mailboxId] = "delete";
          render();
          send("delete", { mailboxId: request.mailboxId });
          return;
        }
        pendingBatchAction = "batchDelete";
        render();
        send("batchDelete", { mailboxIds: request.mailboxIds });
      }

      function renderDeleteConfirmModal() {
        if (!deleteConfirm) return "";
        const isBatch = deleteConfirm.kind === "batch";
        const title = isBatch ? "批量删除邮箱" : "删除邮箱";
        const body = isBatch
          ? '确定删除已选择的 ' + deleteConfirm.mailboxIds.length + ' 个邮箱吗？本地凭据和邮件详情也会一并清理。'
          : '确定删除邮箱 ' + esc(deleteConfirm.address) + ' 吗？本地凭据和邮件详情也会一并清理。';
        return '<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="deleteConfirmTitle"><h2 id="deleteConfirmTitle">' + title + '</h2><p class="muted">' + body + '</p><div class="modal-actions"><button type="button" data-action="cancel-delete">取消</button><button type="button" class="danger" data-action="confirm-delete">确认删除</button></div></section></div>';
      }

      function requestCodexImport(mailboxId) {
        if (!mailboxId || pendingCodexImports[mailboxId]) return;
        pendingCodexImports[mailboxId] = true;
        render();
        send("codexImport", { mailboxId });
      }

      function closestTarget(event, selector) {
        const target = event?.target;
        return target && typeof target.closest === "function" ? target.closest(selector) : null;
      }
      function clearPressedButtons() {
        document.querySelectorAll("button.is-pressed").forEach((button) => button.classList.remove("is-pressed"));
      }
      function send(action, payload = {}) { vscode.postMessage({ type: "mailbox:action", action, ...payload }); }
      function showNotice(message, level) {
        notice.textContent = message || "";
        notice.className = "notice visible" + (level ? " " + level : "");
        if (notice.style) notice.style.color = "";
      }
      function formatDate(value) { if (!value) return "未知时间"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
      function esc(value) { return String(value ?? "").replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
      render();
      send("ready");
    })();
  </script>
</body>
</html>`;
}

function createRegistrationPanelHtml() {
  return createMailboxPanelHtml({ mode: "registration" });
}

module.exports = {
  MAILBOX_PANEL_VIEW_TYPE,
  REGISTRATION_PANEL_VIEW_TYPE,
  createMailboxPanelHtml,
  createRegistrationPanelHtml
};
