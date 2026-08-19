import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenAIPageAnalyzer, DEFAULT_WEB_MODEL, PAGE_ANALYSIS_RESPONSE_SCHEMA } from "../src/webAnalyzer.mjs";

const snapshot = {
  url: "https://shop.example.invalid/products",
  title: "Example shop",
  siteStatus: "available",
  text: "Free verified accounts are available.",
  links: [],
  structuredData: [],
  requiresBrowser: false
};

describe("OpenAI webpage analyzer", () => {
  it("uses Responses structured JSON schema output and normalizes the result", async () => {
    let request;
    const analyzer = createOpenAIPageAnalyzer({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return response({
          output_text: JSON.stringify({
            title: "Example shop",
            siteStatus: "available",
            unavailableReason: null,
            requiresBrowser: false,
            products: [
              {
                id: "free-1",
                name: "Free verified account",
                plan: "free",
                priceFen: 350,
                currency: "CNY",
                inStock: true,
                stockCount: 3,
                phoneVerified: true,
                features: ["接码"],
                purchaseUrl: "https://shop.example.invalid/buy/free-1",
                evidence: [{ quote: "available", source: "page" }]
              }
            ],
            instructions: [
              {
                order: 1,
                action: "submit",
                target: "pay",
                value: null,
                sensitive: false,
                requiresConfirmation: true,
                evidence: []
              }
            ],
            warnings: []
          })
        });
      }
    });

    const result = await analyzer.analyze(snapshot, { criteria: { plan: "free" } });
    assert.equal(result.products[0].priceFen, 350);
    assert.equal(result.instructions[0].requiresConfirmation, true);
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    assert.equal(request.init.headers.authorization, "Bearer test-key");
    const body = JSON.parse(request.init.body);
    assert.equal(body.model, DEFAULT_WEB_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema, PAGE_ANALYSIS_RESPONSE_SCHEMA);
  });

  it("rejects incomplete and refused model responses", async () => {
    const incomplete = createOpenAIPageAnalyzer({
      apiKey: "test-key",
      fetchImpl: async () => response({ status: "incomplete" })
    });
    await assert.rejects(() => incomplete.analyze(snapshot), /不完整/u);

    const refused = createOpenAIPageAnalyzer({
      apiKey: "test-key",
      fetchImpl: async () =>
        response({ output: [{ type: "message", content: [{ type: "refusal", refusal: "拒绝" }] }] })
    });
    await assert.rejects(() => refused.analyze(snapshot), /拒绝/u);
  });
});

function response(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body;
    }
  };
}
