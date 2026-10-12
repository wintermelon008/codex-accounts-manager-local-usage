import { describe, expect, it } from "vitest";
import { testProxyCandidates, type ProxyProbeResult } from "../src/infrastructure/config/proxyHealth";

describe("proxy health candidate selection", () => {
  it("tests the selected proxy first, de-duplicates addresses, and chooses the first healthy fallback", async () => {
    const calls: string[] = [];
    const results: Record<string, ProxyProbeResult> = {
      "http://selected:8080": {
        address: "http://selected:8080",
        ok: false,
        latencyMs: 120,
        reason: "connection"
      },
      "http://slow:8080": {
        address: "http://slow:8080",
        ok: false,
        latencyMs: 300,
        reason: "timeout"
      },
      "http://healthy:8080": {
        address: "http://healthy:8080",
        ok: true,
        latencyMs: 80
      }
    };

    const summary = await testProxyCandidates(
      ["http://healthy:8080", "http://selected:8080", "http://slow:8080", "http://healthy:8080"],
      " http://selected:8080 ",
      async (address) => {
        calls.push(address);
        return results[address]!;
      }
    );

    expect(calls).toEqual(["http://selected:8080", "http://healthy:8080", "http://slow:8080"]);
    expect(summary.selectedAddress).toBe("http://selected:8080");
    expect(summary.selectedResult.ok).toBe(false);
    expect(summary.fallbackAddress).toBe("http://healthy:8080");
  });

  it("does not switch away from a healthy selected proxy", async () => {
    const summary = await testProxyCandidates(["", "http://backup:8080"], "", async (address) => ({
      address,
      ok: address === "" || address === "http://backup:8080",
      latencyMs: address === "" ? 40 : 20
    }));

    expect(summary.results.map((result) => result.address)).toEqual(["", "http://backup:8080"]);
    expect(summary.selectedResult.ok).toBe(true);
    expect(summary.fallbackAddress).toBeUndefined();
  });

  it("keeps a failed selection unchanged when no candidate is healthy", async () => {
    const summary = await testProxyCandidates(["http://backup:8080"], "http://selected:8080", async (address) => ({
      address,
      ok: false,
      reason: "connection"
    }));

    expect(summary.fallbackAddress).toBeUndefined();
    expect(summary.results).toHaveLength(2);
  });
});
