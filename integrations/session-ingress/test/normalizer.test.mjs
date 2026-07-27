import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeManagerSharedEntries,
  normalizeSub2ApiPayload,
  parseSessionRecords,
  SessionNormalizationError
} from "../src/index.mjs";

const idToken = jwt({ email: "person@example.invalid", chatgpt_account_id: "account-1", user_id: "user-1" });
const accessToken = jwt({ email: "person@example.invalid", plan_type: "free" });

describe("session normalization", () => {
  it("normalizes supported Codex, CPA, Cockpit, Manager, and Sub2API-style fields for Manager", () => {
    const fixtures = [
      { auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: accessToken } },
      { session_token: "legacy", idToken, accessToken },
      { type: "cookpit", account_note: "sample", credentials: { id_token: idToken, access_token: accessToken } },
      { meta: { source: "manager" }, tokens: { id_token: idToken, access_token: accessToken } },
      {
        type: "sub2api-data",
        accounts: [{ platform: "openai", type: "oauth", credentials: { id_token: idToken, access_token: accessToken } }],
        proxies: []
      }
    ];

    for (const fixture of fixtures) {
      const entries = normalizeManagerSharedEntries(JSON.stringify(fixture));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].email, "person@example.invalid");
      assert.equal(entries[0].tokens.access_token, accessToken);
      assert.equal(entries[0].tokens.id_token, idToken);
    }
  });

  it("recovers only known fields from incomplete JSON-like input", () => {
    const partial = `Cockpit copied text\naccess_token: "${accessToken}",\nid_token: "${idToken}",\nemail: "person@example.invalid"`;
    const records = parseSessionRecords(partial);
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceFormat, "cockpit");
    assert.equal(records[0].accessToken, accessToken);
    assert.equal(normalizeManagerSharedEntries(partial)[0].email, "person@example.invalid");
  });

  it("keeps a complete native Sub2API export and converts other sessions to the standard envelope", () => {
    const native = {
      type: "sub2api-data",
      version: 1,
      exported_at: "2026-01-01T00:00:00.000Z",
      accounts: [{ name: "native", platform: "openai", type: "oauth", credentials: { access_token: "opaque" } }],
      proxies: [{ name: "proxy" }]
    };
    assert.deepEqual(normalizeSub2ApiPayload(JSON.stringify(native)), native);

    const converted = normalizeSub2ApiPayload(JSON.stringify({ session_token: "cpa", idToken, accessToken }), {
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    assert.deepEqual(
      {
        type: converted.type,
        version: converted.version,
        exported_at: converted.exported_at,
        proxies: converted.proxies,
        account: converted.accounts[0]
      },
      {
        type: "sub2api-data",
        version: 1,
        exported_at: "2026-01-01T00:00:00.000Z",
        proxies: [],
        account: {
          name: "person@example.invalid",
          platform: "openai",
          type: "oauth",
          credentials: {
            access_token: accessToken,
            id_token: idToken,
            email: "person@example.invalid",
            chatgpt_account_id: "account-1",
            chatgpt_user_id: "user-1",
            plan_type: "free"
          }
        }
      }
    );
  });

  it("fails closed for unsigned JWTs or Manager imports without an ID token", () => {
    const unsigned = `${base64({ alg: "none" })}.${base64({ email: "person@example.invalid" })}.signature`;
    assert.throws(
      () => normalizeManagerSharedEntries(JSON.stringify({ id_token: unsigned, access_token: accessToken })),
      SessionNormalizationError
    );
    assert.throws(
      () => normalizeManagerSharedEntries(JSON.stringify({ access_token: accessToken })),
      /id_token/u
    );
  });
});

function jwt(payload) {
  return `${base64({ alg: "HS256", typ: "JWT" })}.${base64(payload)}.test-signature`;
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
