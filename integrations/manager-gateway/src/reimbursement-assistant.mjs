import { readFile } from "node:fs/promises";

const REQUIRED_ROLES = ["invoice", "payment", "order"];
const ROLE_LABELS = { invoice: "发票/收据", payment: "支付截图", order: "订单截图" };
const ACTION_LIMIT = 12;

export class ReimbursementAssistantError extends Error {
  constructor(message, code = "reimbursement_assistant_error") {
    super(message);
    this.name = "ReimbursementAssistantError";
    this.code = code;
  }
}

export class ReimbursementAssistant {
  #dataUrl;
  #dataToken;
  #attachments;
  #publicBaseUrl;

  constructor({ dataUrl, dataToken, attachments, publicBaseUrl }) {
    this.#dataUrl = typeof dataUrl === "string" ? dataUrl.replace(/\/+$/u, "") : "";
    this.#dataToken = dataToken;
    this.#attachments = attachments;
    this.#publicBaseUrl = publicBaseUrl;
  }

  async execute({ session, result, attachments = [], signal }) {
    const plan = parsePlan(result?.text);
    if (!plan) {
      return {
        ...result,
        text: "报销助手没有返回可执行的结构化结果，请换一种说法再试一次。",
      };
    }
    if (!this.#dataUrl) {
      return { ...result, text: "Workbench 数据服务尚未接入，报销操作没有执行。" };
    }
    if (plan.needsInput) {
      return { ...result, text: plan.needsInput };
    }
    const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, ACTION_LIMIT) : [];
    const refs = new Map();
    const lines = [];
    let artifact;
    let executed = 0;
    const source = normalizeSource(session?.context, session?.id);
    try {
      for (const action of actions) {
        const outcome = await this.#executeAction(action, { refs, attachments, source, signal });
        if (!outcome) continue;
        executed += 1;
        if (outcome.ref) refs.set(outcome.ref, outcome.value);
        if (outcome.artifact) artifact = outcome.artifact;
        if (outcome.line) lines.push(outcome.line);
      }
    } catch (error) {
      lines.push(`操作在第 ${executed + 1} 步停止：${error instanceof Error ? error.message : String(error)}`);
    }
    const reply = typeof plan.reply === "string" && plan.reply.trim() ? plan.reply.trim() : "已处理报销请求。";
    return {
      ...result,
      text: [reply, ...lines].filter(Boolean).join("\n"),
      ...(artifact ? { reimbursement: artifact } : {}),
    };
  }

  async #executeAction(action, { refs, attachments, source, signal }) {
    if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
    const type = typeof action.type === "string" ? action.type : "";
    if (type === "group.create") {
      const parentId = await this.#resolveGroupId(action, refs, signal);
      const group = await this.#request("/api/workbench/reimbursements/groups", {
        method: "POST",
        body: JSON.stringify({
          name: action.name,
          code: action.code,
          parentId,
          periodFrom: action.periodFrom,
          periodTo: action.periodTo,
        }),
        signal,
      });
      return {
        ref: stringOrUndefined(action.ref),
        value: group.group,
        line: `已创建报销大项：${group.group?.name ?? group.group?.id ?? "未知"}（${group.group?.id ?? "未知"}）`,
      };
    }
    if (type === "item.create") {
      const groupId = await this.#resolveGroupId(action, refs, signal);
      const item = await this.#request("/api/workbench/reimbursements", {
        method: "POST",
        body: JSON.stringify({
          title: action.title,
          merchant: action.merchant,
          amountMinor: action.amountMinor,
          currency: action.currency,
          expenseDate: action.expenseDate,
          purpose: action.purpose,
          groupId,
          status: action.status,
          statusDate: action.statusDate,
          sourceChannel: source.channel,
          sourceActorId: source.actorId,
          sourceChatId: source.chatId,
        }),
        signal,
      });
      const created = item.item;
      if (source.channel && source.chatId && source.actorId && created?.id) {
        await this.#request("/api/workbench/reimbursements/intake", {
          method: "PUT",
          body: JSON.stringify({
            channel: source.channel,
            chatId: source.chatId,
            actorId: source.actorId,
            itemId: created.id,
            pendingRole: nextRole(created),
            state: "active",
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
          }),
          signal,
        });
      }
      return {
        ref: stringOrUndefined(action.ref),
        value: created,
        line: `已创建报销事项：${created?.title ?? created?.id ?? "未知"}（${created?.id ?? "未知"}）`,
      };
    }
    if (type === "item.update") {
      const itemId = await this.#resolveItemId(action, refs, source, signal);
      const response = await this.#request(`/api/workbench/reimbursements/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: action.title,
          merchant: action.merchant,
          amountMinor: action.amountMinor,
          currency: action.currency,
          expenseDate: action.expenseDate,
          purpose: action.purpose,
          groupId: action.groupId,
          status: action.status,
          statusDate: action.statusDate,
        }),
        signal,
      });
      return { value: response.item, line: `已更新报销事项：${response.item?.title ?? itemId}` };
    }
    if (type === "evidence.attach") {
      const itemId = await this.#resolveItemId(action, refs, source, signal);
      const role = normalizeRole(action.role);
      const index = Number(action.attachmentIndex);
      const attachment = Number.isInteger(index) ? attachments[index] : undefined;
      if (!attachment) throw new ReimbursementAssistantError(`找不到附件 ${action.attachmentIndex ?? "?"}`);
      const file = this.#attachments?.resolve(attachment.id);
      if (!file?.path) throw new ReimbursementAssistantError("报销附件已过期，请重新发送图片");
      const bytes = await readFile(file.path);
      const response = await this.#request(`/api/workbench/reimbursements/${encodeURIComponent(itemId)}/evidence`, {
        method: "POST",
        headers: {
          "content-type": file.mimeType,
          "x-workbench-filename": encodeURIComponent(file.filename),
          "x-workbench-role": role,
          "x-workbench-source-channel": source.channel,
          "x-workbench-source-message-id": `${source.messageId}:${attachment.id}`,
        },
        body: bytes,
        signal,
      });
      await this.#attachments?.remove(attachment.id);
      const item = response.item;
      return {
        value: item,
        line: `已归档${ROLE_LABELS[role]}：${item?.title ?? itemId}；还缺${(item?.missingEvidence ?? []).map((missing) => ROLE_LABELS[missing] ?? missing).join("、") || "无"}`,
      };
    }
    if (type === "group.export_pdf") {
      const groupId = await this.#resolveGroupId(action, refs, signal);
      if (!groupId) throw new ReimbursementAssistantError("没有找到要导出的报销大项");
      const response = await this.#request("/api/workbench/reimbursements/export", {
        method: "POST",
        body: JSON.stringify({
          rootGroupId: groupId,
          includeDescendants: action.includeDescendants !== false,
          periodFrom: action.periodFrom,
          periodTo: action.periodTo,
          mode: "full",
        }),
        signal,
      });
      const exportJob = response.export;
      const artifact = await this.#copyExportToGateway(exportJob, signal);
      return {
        value: exportJob,
        artifact,
        line: `已生成完整 PDF 汇总：${exportJob?.id ?? "未知"}，共 ${exportJob?.manifest?.itemIds?.length ?? 0} 个报销事项。`,
      };
    }
    if (type === "group.list" || type === "item.list") {
      const isGroup = type === "group.list";
      const query = encodeURIComponent(typeof action.query === "string" ? action.query : "");
      const response = await this.#request(`${isGroup ? "/api/workbench/reimbursements/groups" : "/api/workbench/reimbursements"}?query=${query}`, { signal });
      const values = isGroup ? response.groups : response.items;
      return { line: formatList(isGroup ? "报销大项" : "报销事项", values) };
    }
    return undefined;
  }

  async #resolveGroupId(action, refs, signal) {
    const ref = stringOrUndefined(action.groupRef);
    if (ref && refs.get(ref)?.id) return refs.get(ref).id;
    if (stringOrUndefined(action.groupId)) return action.groupId;
    const query = stringOrUndefined(action.parentQuery ?? action.groupQuery);
    if (!query) return undefined;
    const response = await this.#request(`/api/workbench/reimbursements/groups?query=${encodeURIComponent(query)}`, { signal });
    const groups = Array.isArray(response.groups) ? response.groups : [];
    if (groups.length !== 1) throw new ReimbursementAssistantError(groups.length === 0 ? `没有找到报销大项“${query}”` : `找到多个报销大项“${query}”，请补充名称或 ID`);
    return groups[0].id;
  }

  async #resolveItemId(action, refs, source, signal) {
    const ref = stringOrUndefined(action.itemRef);
    if (ref && refs.get(ref)?.id) return refs.get(ref).id;
    if (stringOrUndefined(action.itemId)) return action.itemId;
    const query = stringOrUndefined(action.itemQuery);
    if (query) {
      const response = await this.#request(`/api/workbench/reimbursements?query=${encodeURIComponent(query)}`, { signal });
      const items = Array.isArray(response.items) ? response.items : [];
      if (items.length !== 1) throw new ReimbursementAssistantError(items.length === 0 ? `没有找到报销事项“${query}”` : `找到多个报销事项“${query}”，请补充名称或 ID`);
      return items[0].id;
    }
    if (source.channel && source.chatId && source.actorId) {
      const intake = await this.#request(`/api/workbench/reimbursements/intake?channel=${encodeURIComponent(source.channel)}&chatId=${encodeURIComponent(source.chatId)}&actorId=${encodeURIComponent(source.actorId)}`, { signal });
      if (intake.intake?.itemId) return intake.intake.itemId;
    }
    throw new ReimbursementAssistantError("没有找到当前报销事项，请先说明报销事项名称或 ID");
  }

  async #copyExportToGateway(exportJob, signal) {
    if (!exportJob?.fileUrl || !this.#attachments) return undefined;
    const response = await this.#request(exportJob.fileUrl, { signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    const attachment = await this.#attachments.create({
      filename: `reimbursement-${exportJob.id}.pdf`,
      mimeType: "application/pdf",
      bytes,
      ...(this.#publicBaseUrl ? { publicBaseUrl: this.#publicBaseUrl } : {}),
    });
    return {
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url: attachment.url,
    };
  }

  async #request(path, init = {}) {
    const target = path.startsWith("http") ? path : `${this.#dataUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.#dataToken) headers.set("authorization", `Bearer ${this.#dataToken}`);
    const response = await fetch(target, { ...init, headers });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        if (typeof body?.error === "string") detail = body.error;
      } catch {
        // Keep the HTTP status for non-JSON errors.
      }
      throw new ReimbursementAssistantError(`${detail || "Workbench 报销接口请求失败"}（HTTP ${response.status}）`, "workbench_request_failed");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return response.json();
    return response;
  }
}

function parsePlan(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRole(value) {
  if (!["invoice", "payment", "order"].includes(value)) throw new ReimbursementAssistantError("报销凭证类型必须是 invoice、payment 或 order");
  return value;
}

function normalizeSource(context, sessionId) {
  return {
    channel: stringOrUndefined(context?.sourceChannel) ?? "",
    actorId: stringOrUndefined(context?.sourceActorId) ?? (context?.sourceChannel === "workbench" ? "workbench-user" : ""),
    chatId: stringOrUndefined(context?.sourceChatId) ?? (context?.sourceChannel === "workbench" ? sessionId ?? "" : ""),
    messageId: stringOrUndefined(context?.sourceMessageId) ?? `gateway-${Date.now()}`,
  };
}

function nextRole(item) {
  return REQUIRED_ROLES.find((role) => !(item?.evidence ?? []).some((evidence) => evidence.role === role)) ?? null;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatList(label, values) {
  if (!Array.isArray(values) || values.length === 0) return `${label}：暂无记录。`;
  return [`${label}：`, ...values.slice(0, 20).map((value) => `- ${value.name ?? value.title ?? "未命名"}（${value.id}）`)].join("\n");
}
