import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GatewaySessionManager } from "../src/session-manager.mjs";
import { GatewayUsageLedger, normalizeTokenUsage } from "../src/usage.mjs";

describe("Gateway usage accounting", () => {
  it("normalizes Codex/OpenAI usage details and persists daily model totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "manager-gateway-usage-"));
    try {
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const ledger = new GatewayUsageLedger({ stateDir: root, now: () => now, timeZone: "UTC" });
      await ledger.init();
      await ledger.record({
        model: "GPT-6-ASTRA",
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 25 },
        output_tokens_details: { reasoning_tokens: 10 }
      });
      await ledger.record({
        model: "gpt-6-astra",
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1
      });

      assert.deepEqual(ledger.snapshot(), {
        status: "ready",
        date: "2026-09-05",
        timeZone: "UTC",
        calculatedAt: now,
        eventCount: 2,
        total: {
          inputTokens: 110,
          cachedInputTokens: 27,
          outputTokens: 45,
          reasoningOutputTokens: 11,
          totalTokens: 155
        },
        byModel: [
          {
            model: "gpt-6-astra",
            inputTokens: 110,
            cachedInputTokens: 27,
            outputTokens: 45,
            reasoningOutputTokens: 11,
            totalTokens: 155
          }
        ]
      });

      const persisted = JSON.parse(await readFile(join(root, "usage-ledger-v1.json"), "utf8"));
      assert.equal(persisted.schemaVersion, 1);
      assert.doesNotMatch(JSON.stringify(persisted), /authorization|api[_-]?key|secret|prompt|response/u);

      const restored = new GatewayUsageLedger({ stateDir: root, now: () => now, timeZone: "UTC" });
      await restored.init();
      assert.equal(restored.snapshot().total.totalTokens, 155);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accounts a session without requiring a Manager control interface", async () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const ledger = new GatewayUsageLedger({ now: () => now, timeZone: "UTC" });
    const sessions = new GatewaySessionManager({
      usage: ledger,
      provider: {
        async run() {
          return {
            text: "done",
            usage: normalizeTokenUsage({
              model: "gpt-6-astra",
              input_tokens: 12,
              output_tokens: 3,
              total_tokens: 15
            })
          };
        }
      }
    });

    const session = sessions.create({ mode: "develop", message: "no Manager API" });
    await sessions.waitForTerminal(session.id);

    assert.equal(sessions.get(session.id)?.status, "completed");
    assert.deepEqual(sessions.get(session.id)?.result?.usage, {
      model: "gpt-6-astra",
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 15
    });
    assert.equal(ledger.snapshot().total.totalTokens, 15);
  });
});
