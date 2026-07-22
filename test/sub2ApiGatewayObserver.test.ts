import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSub2ApiGatewayInventory } from "../src/local/sub2apiGateway/observer";

describe("Sub2API Gateway inventory observer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aggregates only readable, schedulable upstream quota windows without retaining account details", async () => {
    const requests: Array<{ url: string; apiKey: string | null; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        requests.push({
          url: `${url.pathname}${url.search}`,
          apiKey: headers.get("x-api-key"),
          authorization: headers.get("authorization")
        });
        if (url.pathname === "/api/v1/admin/groups/all") {
          return jsonResponse({ data: [{ id: 9, name: "test" }] });
        }
        if (url.pathname === "/api/v1/admin/accounts") {
          return jsonResponse({
            data: {
              total: 3,
              items: [
                { id: 11, status: "normal" },
                { id: 12, status: "normal" },
                { id: 13, status: "disabled" }
              ]
            }
          });
        }
        if (url.pathname.endsWith("/11/quota")) {
          return jsonResponse({
            data: {
              rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1_800_000_000 },
                secondary_window: { used_percent: 50, reset_at: 1_800_100_000 }
              }
            }
          });
        }
        if (url.pathname.endsWith("/12/quota")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const snapshot = await fetchSub2ApiGatewayInventory(
      {
        adminBaseUrl: "http://127.0.0.1:65432",
        group: "test",
        credentialRef: "observer",
        refreshSeconds: 300
      },
      "admin-observer-key"
    );

    expect(snapshot).toMatchObject({
      group: "test",
      eligibleAccountCount: 2,
      observedAccountCount: 1,
      fiveHour: {
        accountCount: 1,
        remainingUnits: 0.75,
        capacityUnits: 1,
        remainingPercent: 75,
        earliestResetAt: 1_800_000_000_000
      },
      weekly: {
        accountCount: 1,
        remainingUnits: 0.5,
        capacityUnits: 1,
        remainingPercent: 50,
        earliestResetAt: 1_800_100_000_000
      }
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/api/v1/admin/groups/all?platform=openai", apiKey: "admin-observer-key", authorization: null }),
        expect.objectContaining({ url: "/api/v1/admin/accounts?platform=openai&group=9&page=1&page_size=100" }),
        expect.objectContaining({ url: "/api/v1/admin/openai/accounts/11/quota" })
      ])
    );
    expect(JSON.stringify(snapshot)).not.toContain("11");
    expect(JSON.stringify(snapshot)).not.toContain("admin-observer-key");
  });

  it("does not convert an unreadable account into a fabricated exhausted pool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/admin/groups/all") {
          return jsonResponse({ data: [{ id: "test", name: "test" }] });
        }
        if (url.pathname === "/api/v1/admin/accounts") {
          return jsonResponse({ data: [{ id: 1, status: "normal" }] });
        }
        return new Response("forbidden", { status: 403 });
      })
    );

    await expect(
      fetchSub2ApiGatewayInventory(
        {
          adminBaseUrl: "http://127.0.0.1:65432",
          group: "test",
          credentialRef: "observer",
          refreshSeconds: 300
        },
        "admin-observer-key"
      )
    ).rejects.toThrow("could not read");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
