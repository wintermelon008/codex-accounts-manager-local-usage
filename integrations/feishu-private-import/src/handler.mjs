import {
  enqueueManagerImport,
  enqueueSub2ApiImport,
  formatManagerImportStatus,
  readManagerImportStatus,
  toSafeIngressError
} from "../vendor/session-ingress/index.mjs";
import { parseImportCommand } from "./command.mjs";

export const PRIVATE_CHAT_ONLY_MESSAGE = "账号导入仅支持与机器人的一对一私聊；不会在群聊、文档评论或其他会话中读取 m+ / s+ 内容。";
export const UNAUTHORIZED_MESSAGE = "账号导入\n拒绝操作：当前发送者不在管理员白名单中。";

/**
 * Process an already-authenticated Feishu event. Authorization and chat scope
 * are checked before the command payload reaches any session parser.
 */
export async function handlePrivateImportEvent(event, options) {
  const message = event?.message;
  const sender = event?.sender;
  const text = extractTextContent(message?.content);
  const command = parseImportCommand(text);
  if (!command) {
    return { handled: false };
  }

  if (message?.chat_type !== "p2p") {
    return { handled: true, reply: PRIVATE_CHAT_ONLY_MESSAGE };
  }
  const senderOpenId = sender?.sender_id?.open_id;
  if (typeof senderOpenId !== "string" || !options.adminOpenIds.has(senderOpenId)) {
    return { handled: true, reply: UNAUTHORIZED_MESSAGE };
  }

  if (command.target === "manager") {
    return handleManagerCommand(command, options);
  }
  return handleSub2ApiCommand(command, options);
}

export function extractTextContent(content) {
  if (typeof content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function handleManagerCommand(command, options) {
  if (command.action === "help") {
    return { handled: true, reply: managerHelp() };
  }
  if (command.action === "status") {
    if (!command.argument || command.argument.startsWith("{") || command.argument.startsWith("[")) {
      return { handled: true, reply: "Codex 账号导入\n“Manager 导入状态”后只能跟任务编号；未创建任务。" };
    }
    return readManagerImportStatus(command.argument, options.queueOptions)
      .then((status) => ({ handled: true, reply: formatManagerImportStatus(status) }))
      .catch((error) => ({ handled: true, reply: `Codex 账号导入\n${toSafeIngressError(error).message}` }));
  }
  if (!command.argument) {
    return { handled: true, reply: managerHelp() };
  }
  return enqueueManagerImport(command.argument, options.queueOptions)
    .then((queued) => ({
      handled: true,
      reply:
        "Codex 账号导入\n" +
        `已接收 ${queued.accountCount} 个账号并写入本地受限队列。任务编号：${queued.id}\n` +
        "Codex Accounts Manager 启动后会导入、刷新额度，并仅将合格账号加入无感池。"
    }))
    .catch((error) => ({ handled: true, reply: `Codex 账号导入\n未创建任务：${toSafeIngressError(error).message}` }));
}

function handleSub2ApiCommand(command, options) {
  if (command.action === "help" || !command.argument) {
    return { handled: true, reply: sub2apiHelp() };
  }
  return enqueueSub2ApiImport(command.argument, options.queueOptions)
    .then((queued) => ({
      handled: true,
      reply:
        "Sub2API 账号导入\n" +
        `已生成标准 sub2api-data 载荷（${queued.accountCount} 个账号，${queued.proxyCount} 个代理）。任务编号：${queued.id}\n` +
        "已安装并显式配置的 Sub2API 导入器会处理该本地任务。"
    }))
    .catch((error) => ({ handled: true, reply: `Sub2API 账号导入\n未创建任务：${toSafeIngressError(error).message}` }));
}

function managerHelp() {
  return (
    "Codex 账号导入\n" +
    "m+ <会话 JSON>：仅管理员，接收 Codex、CPA、Cockpit、Manager 或 Sub2API 会话并转换为 Manager 格式。\n" +
    "Manager 导入状态 <任务编号>：查询脱敏处理状态。\n\n" +
    "支持完整 JSON、代码围栏和不完整键值文本；不会回显或记录令牌。"
  );
}

function sub2apiHelp() {
  return (
    "Sub2API 账号导入\n" +
    "s+ <会话 JSON>：仅管理员，接收 Sub2API、Codex、CPA、Cockpit 或 Manager 会话并输出标准 sub2api-data。\n\n" +
    "原生完整 Sub2API 导出保持原结构；其他格式会安全转换。不会回显或记录令牌。"
  );
}
