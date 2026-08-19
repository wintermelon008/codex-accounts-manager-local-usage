import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createDeterministicPageAnalyzer } from "../src/webAnalyzer.mjs";
import { createPageSnapshot } from "../src/webPage.mjs";
import { createWebWorkflowService, WebWorkflowError } from "../src/webWorkflowService.mjs";
import { createWebWorkflowStore } from "../src/webWorkflowStore.mjs";
import { normalizePageAnalysis, rankProducts } from "../src/webWorkflowSchema.mjs";

const PAGE_URL = "https://shop.example.invalid/products";

describe("web page analysis and workflow reuse", () => {
  it("detects the investigated parked-domain response", () => {
    const snapshot = createPageSnapshot({
      url: "https://riceai.cc/products/chatgpt-free-account",
      html: `
        <html><head><title>ChatGPT Free Account</title></head>
        <body><script>window.LANDER_SYSTEM="PW"</script>Domain is for sale</body></html>
      `
    });
    assert.equal(snapshot.siteStatus, "unavailable");
    assert.match(snapshot.unavailableReason, /停放页/u);
    const modelAttempt = normalizePageAnalysis(
      {
        siteStatus: "available",
        products: [{ id: "fake", name: "fake", priceFen: 1, inStock: true }],
        instructions: [{ action: "submit", target: "fake-pay" }]
      },
      snapshot
    );
    assert.equal(modelAttempt.siteStatus, "unavailable");
    assert.deepEqual(modelAttempt.products, []);
    assert.deepEqual(modelAttempt.instructions, []);
  });

  it("extracts JSON-LD products and ranks free verified stock by price", async () => {
    const snapshot = createPageSnapshot({
      url: PAGE_URL,
      html: `
        <html><head><title>Account shop</title>
          <script type="application/ld+json">${JSON.stringify({
            "@type": "ItemList",
            itemListElement: [
              {
                item: {
                  "@type": "Product",
                  sku: "free-expensive",
                  name: "Free verified account - premium",
                  category: "free",
                  offers: { price: "9.9", priceCurrency: "CNY", availability: "https://schema.org/InStock" }
                }
              },
              {
                item: {
                  "@type": "Product",
                  sku: "free-cheap",
                  name: "Free verified account",
                  category: "free",
                  offers: { price: "3.5", priceCurrency: "CNY", availability: "https://schema.org/InStock" }
                }
              }
            ]
          })}</script>
        </head><body>Free accounts available</body></html>
      `
    });
    const analysis = await createDeterministicPageAnalyzer().analyze(snapshot);
    const products = normalizePageAnalysis({
      ...analysis,
      products: [
        { ...analysis.products[0], phoneVerified: true },
        { ...analysis.products[1], phoneVerified: true }
      ]
    });
    const ranked = rankProducts(products.products, "free 已接码 有库存 最低价");
    assert.equal(ranked.candidates[0].id, "free-cheap");
    assert.equal(ranked.candidates[0].priceFen, 350);
  });

  it("saves steps privately and does not persist sensitive values", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-web-workflow-"));
    try {
      const statePath = path.join(temporaryDirectory, "nested", "workflows.json");
      const store = createWebWorkflowStore({ statePath });
      const service = createWebWorkflowService({
        store,
        now: () => "2026-08-18T12:00:00.000Z",
        fetchPage: async () => ({
          url: PAGE_URL,
          title: "Example shop",
          text: "Free verified account",
          links: [],
          structuredData: [],
          requiresBrowser: false,
          siteStatus: "available"
        }),
        analyzer: {
          async analyze() {
            return {
              title: "Example shop",
              siteStatus: "available",
              requiresBrowser: false,
              products: [
                {
                  id: "free-1",
                  name: "Free account",
                  plan: "free",
                  priceFen: 100,
                  currency: "CNY",
                  inStock: true,
                  stockCount: 2,
                  phoneVerified: true,
                  features: ["接码"],
                  purchaseUrl: PAGE_URL,
                  evidence: []
                }
              ],
              instructions: [
                { order: 1, action: "fill", target: "email", value: "buyer@example.invalid" },
                { order: 2, action: "fill", target: "password", value: "do-not-store-this", sensitive: true },
                { order: 3, action: "submit", target: "pay-button" }
              ],
              warnings: []
            };
          }
        }
      });

      const plan = await service.analyze({ url: PAGE_URL, criteria: "free 已接码 有库存 最低价" });
      assert.equal(plan.remembered, true);
      assert.equal(plan.selected.id, "free-1");
      assert.equal(plan.instructions[1].value, null);
      assert.equal((await service.getSaved(PAGE_URL)).selected.id, "free-1");
      const encoded = await fs.readFile(statePath, "utf8");
      assert.doesNotMatch(encoded, /do-not-store-this/u);
      assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("only invokes an explicit executor after a confirmed paid state", async () => {
    let calls = 0;
    const store = {
      async get() {
        return {
          schema: "feishu-assistant-web-workflow/v1",
          url: PAGE_URL,
          title: "Example shop",
          siteStatus: "available",
          criteria: { plan: "free", inStock: true, sort: "price_asc" },
          analysis: {
            title: "Example shop",
            siteStatus: "available",
            products: [
              {
                id: "free-1",
                name: "Free account",
                plan: "free",
                priceFen: 100,
                currency: "CNY",
                inStock: true,
                phoneVerified: true,
                features: [],
                evidence: []
              }
            ],
            instructions: [],
            warnings: []
          },
          updatedAt: "2026-08-18T12:00:00.000Z"
        };
      },
      async put() {}
    };
    const service = createWebWorkflowService({
      store,
      analyzer: { analyze: async () => ({}) },
      executor: {
        async execute() {
          calls += 1;
          return { state: "completed", managerImportJobId: "import-1" };
        }
      }
    });
    await assert.rejects(
      () => service.executeAfterPayment({ url: PAGE_URL, payment: { state: "pending" } }),
      (error) => error instanceof WebWorkflowError && error.code === "web_workflow_payment_required"
    );
    assert.equal(calls, 0);
    const result = await service.executeAfterPayment({ url: PAGE_URL, payment: { state: "paid" } });
    assert.equal(result.state, "completed");
    assert.equal(calls, 1);
  });
});
