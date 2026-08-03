import { describe, expect, it, vi } from "vitest";
import {
  buildQuotaCountdownRequest,
  selectQuotaCountdownModel,
  sendQuotaCountdownStartMessage
} from "../src/services/quotaCountdown";

describe("quota countdown starter service", () => {
  it("prefers a lightweight API-supported visible Codex model", () => {
    expect(
      selectQuotaCountdownModel({
        models: [
          { slug: "gpt-frontier", priority: 1, supported_in_api: true, visibility: "list" },
          { slug: "gpt-luna", priority: 3, supported_in_api: true, visibility: "list" },
          { slug: "gpt-mini-hidden", priority: 2, supported_in_api: true, visibility: "hide" }
        ]
      })
    ).toBe("gpt-luna");
  });

  it("builds a stateless, no-tool, low-reasoning short message", () => {
    expect(buildQuotaCountdownRequest("gpt-luna")).toEqual({
      model: "gpt-luna",
      instructions: "Reply only with OK.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }]
        }
      ],
      tools: [],
      tool_choice: "none",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      include: []
    });
  });

  it("sends the request with only the selected account credentials", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("chatgpt-account-id")).toBe("workspace-1");
      expect(headers.get("accept")).toBe("text/event-stream");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-luna",
        store: false,
        stream: true,
        tools: []
      });
      return new Response(
        [
          'event: response.created\ndata: {"type":"response.created"}',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
          "data: [DONE]"
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    await sendQuotaCountdownStartMessage(
      { accessToken: "secret-token", accountId: "workspace-1" },
      {
        loadModelCache: async () => ({ models: [{ slug: "gpt-luna", supported_in_api: true }] }),
        request
      }
    );

    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("surfaces a bounded upstream error without accepting the response", async () => {
    await expect(
      sendQuotaCountdownStartMessage(
        { accessToken: "secret-token", accountId: "workspace-1" },
        {
          loadModelCache: async () => ({ models: [{ slug: "gpt-luna" }] }),
          request: async () =>
            new Response(JSON.stringify({ error: { message: "model unavailable" } }), { status: 400 })
        }
      )
    ).rejects.toThrow("model unavailable");
  });

  it("surfaces an error event from a successful HTTP stream", async () => {
    await expect(
      sendQuotaCountdownStartMessage(
        { accessToken: "secret-token", accountId: "workspace-1" },
        {
          loadModelCache: async () => ({ models: [{ slug: "gpt-luna" }] }),
          request: async () =>
            new Response('event: error\ndata: {"type":"error","message":"stream failed"}\n\n', {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
        }
      )
    ).rejects.toThrow("stream failed");
  });

  it("rejects a stream that closes without a completion event", async () => {
    await expect(
      sendQuotaCountdownStartMessage(
        { accessToken: "secret-token", accountId: "workspace-1" },
        {
          loadModelCache: async () => ({ models: [{ slug: "gpt-luna" }] }),
          request: async () =>
            new Response('event: response.created\ndata: {"type":"response.created"}\n\n', {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
        }
      )
    ).rejects.toThrow("without a completion event");
  });
});
