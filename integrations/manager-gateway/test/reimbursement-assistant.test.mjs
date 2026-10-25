import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GatewayAttachmentStore } from "../src/attachments.mjs";
import { ReimbursementAssistant } from "../src/reimbursement-assistant.mjs";

const servers = [];
const directories = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Reimbursement assistant", () => {
  it("turns a natural-language plan into Workbench writes, evidence imports, and a full PDF artifact", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "manager-gateway-reimbursement-"));
    directories.push(stateDir);
    const attachments = new GatewayAttachmentStore({ stateDir, maxBytes: 1024 * 1024 });
    await attachments.init();
    const input = await attachments.create({
      filename: "invoice.png",
      mimeType: "image/png",
      bytes: Buffer.from([1, 2, 3])
    });
    const calls = [];
    const server = http.createServer(async (request, response) => {
      const body = request.method === "GET" ? undefined : await readRequestBody(request);
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.method === "POST" && request.url === "/api/workbench/reimbursements/groups") {
        return json(response, 201, { group: { id: "group-1", name: "2026-09 出差" } });
      }
      if (request.method === "POST" && request.url === "/api/workbench/reimbursements") {
        const payload = JSON.parse(body.toString("utf8"));
        assert.equal(payload.status, "submitted");
        assert.equal(payload.statusDate, "2026-09-09");
        return json(response, 201, { item: { id: "item-1", title: "会议注册费", missingEvidence: ["invoice", "payment", "order"] } });
      }
      if (request.method === "PATCH" && request.url === "/api/workbench/reimbursements/item-1") {
        const payload = JSON.parse(body.toString("utf8"));
        assert.equal(payload.status, "submitted");
        assert.equal(payload.statusDate, "2026-09-10");
        return json(response, 200, { item: { id: "item-1", title: "会议注册费", status: "submitted", statusDate: "2026-09-10" } });
      }
      if (request.method === "PUT" && request.url === "/api/workbench/reimbursements/intake") {
        return json(response, 200, { intake: { itemId: "item-1" } });
      }
      if (request.method === "POST" && request.url === "/api/workbench/reimbursements/item-1/evidence") {
        assert.equal(request.headers["x-workbench-role"], "invoice");
        assert.match(request.headers["x-workbench-source-message-id"], /^feishu-message-1:/u);
        assert.deepEqual(body, Buffer.from([1, 2, 3]));
        return json(response, 201, {
          item: { id: "item-1", title: "会议注册费", missingEvidence: ["payment", "order"] }
        });
      }
      if (request.method === "POST" && request.url === "/api/workbench/reimbursements/export") {
        const payload = JSON.parse(body.toString("utf8"));
        assert.equal(payload.mode, "full");
        assert.equal(payload.rootGroupId, "group-1");
        return json(response, 201, {
          export: {
            id: "export-1",
            status: "ready",
            mode: "full",
            manifest: { itemIds: ["item-1"] },
            fileUrl: "/api/workbench/reimbursements/exports/export-1/file"
          }
        });
      }
      if (request.method === "GET" && request.url === "/api/workbench/reimbursements/exports/export-1/file") {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(Buffer.from("%PDF-reimbursement"));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    await listen(server);
    const address = server.address();
    const assistant = new ReimbursementAssistant({
      dataUrl: `http://127.0.0.1:${address.port}`,
      attachments,
      publicBaseUrl: "https://gateway.example.test"
    });

    const result = await assistant.execute({
      session: {
        id: "session-1",
        context: {
          sourceChannel: "feishu",
          sourceActorId: "user-1",
          sourceChatId: "chat-1",
          sourceMessageId: "feishu-message-1"
        }
      },
      result: {
        text: JSON.stringify({
          reply: "我来整理这笔报销。",
          actions: [
            { type: "group.create", ref: "travel", name: "2026-09 出差" },
            { type: "item.create", ref: "expense", groupRef: "travel", title: "会议注册费", amountMinor: 12000, currency: "CNY", status: "submitted", statusDate: "2026-09-09" },
            { type: "item.update", itemId: "item-1", status: "submitted", statusDate: "2026-09-10" },
            { type: "evidence.attach", itemRef: "expense", role: "invoice", attachmentIndex: 0 },
            { type: "group.export_pdf", groupRef: "travel" }
          ]
        })
      },
      attachments: [input]
    });

    assert.match(result.text, /完整 PDF 汇总/u);
    assert.equal(result.reimbursement.mimeType, "application/pdf");
    assert.equal(result.reimbursement.filename, "reimbursement-export-1.pdf");
    assert.match(result.reimbursement.url, /^https:\/\/gateway\.example\.test/u);
    const copied = await attachments.read(result.reimbursement.id);
    assert.equal(copied.bytes.toString(), "%PDF-reimbursement");
    assert.equal(attachments.get(input.id), undefined);
    assert.equal(calls.filter((call) => call.method === "POST").length, 4);
  });
});

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
