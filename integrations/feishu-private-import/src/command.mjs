const STRUCTURED_MENTION_PATTERN = /<at\s+user_id=[^>]+>.*?<\/at>/giu;

/** Identify a namespace without parsing or normalizing the credential payload. */
export function parseImportCommand(text) {
  const command = stripStructuredMentions(text);
  const manager = /^(?:(?:codex|manager)\s*(?:导入|import)|\/?m\+)\s*([\s\S]*)$/iu.exec(command);
  if (manager) {
    return parseTargetArgument("manager", manager[1] ?? "");
  }
  const sub2api = /^(?:\/?sub2api\s*(?:导入|import)|\/?s\+)\s*([\s\S]*)$/iu.exec(command);
  if (sub2api) {
    return parseTargetArgument("sub2api", sub2api[1] ?? "");
  }
  return undefined;
}

export function isImportCommand(text) {
  return parseImportCommand(text) !== undefined;
}

export function stripStructuredMentions(text) {
  return (typeof text === "string" ? text : "").replace(STRUCTURED_MENTION_PATTERN, " ").trim();
}

function parseTargetArgument(target, rawArgument) {
  const argument = rawArgument.trimStart();
  const lowered = argument.toLocaleLowerCase();
  if (["", "帮助", "help", "命令"].includes(lowered)) {
    return { target, action: "help", argument: "" };
  }
  if (target === "manager") {
    if (lowered === "状态" || lowered === "status") {
      return { target, action: "status", argument: "" };
    }
    if (lowered.startsWith("状态")) {
      return { target, action: "status", argument: argument.slice("状态".length).trim() };
    }
    if (lowered.startsWith("status")) {
      return { target, action: "status", argument: argument.slice("status".length).trim() };
    }
  }
  return { target, action: "import", argument };
}
