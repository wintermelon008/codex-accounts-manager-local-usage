import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handlePrivateImportEvent } from "./handler.mjs";

const MAX_EVENT_BYTES = 1_100_000;

export function createFeishuEventServer(options) {
  return http.createServer((request, response) => {
    void handleRequest(request, response, options).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { code: 1, message: "事件处理暂时不可用。" });
      } else {
        response.end();
      }
    });
  });
}

export async function handleFeishuCallback(payload, options) {
  if (!isAuthorizedCallback(payload, options.verificationToken)) {
    return { statusCode: 401, body: { code: 1, message: "verification failed" } };
  }
  if (typeof payload.encrypt === "string") {
    return { statusCode: 400, body: { code: 1, message: "encrypted callbacks are not enabled" } };
  }
  if (payload.type === "url_verification") {
    return { statusCode: 200, body: { challenge: typeof payload.challenge === "string" ? payload.challenge : "" } };
  }
  const eventType = payload.header?.event_type;
  if (eventType !== "im.message.receive_v1") {
    return { statusCode: 200, body: {} };
  }
  const event = payload.event;
  if (event?.sender?.sender_type === "bot") {
    return { statusCode: 200, body: {} };
  }
  const result = await handlePrivateImportEvent(event, {
    adminOpenIds: options.adminOpenIds,
    queueOptions: options.queueOptions
  });
  if (result.handled && result.reply && typeof event?.message?.chat_id === "string") {
    await options.client.sendText(event.message.chat_id, result.reply);
  }
  return { statusCode: 200, body: {} };
}

async function handleRequest(request, response, options) {
  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== options.endpointPath) {
    sendJson(response, 404, { code: 1, message: "not found" });
    return;
  }
  const payload = await readJsonBody(request);
  const result = await handleFeishuCallback(payload, options);
  sendJson(response, result.statusCode, result.body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_EVENT_BYTES) {
      throw new Error("event body too large");
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid event body");
    }
    return parsed;
  } catch {
    throw new Error("invalid event body");
  }
}

function sendJson(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded)
  });
  response.end(encoded);
}

function isAuthorizedCallback(payload, expectedToken) {
  if (!payload || typeof payload !== "object" || typeof expectedToken !== "string" || !expectedToken) {
    return false;
  }
  const candidate = typeof payload.token === "string" ? payload.token : payload.header?.token;
  return typeof candidate === "string" && safeEqual(candidate, expectedToken);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
