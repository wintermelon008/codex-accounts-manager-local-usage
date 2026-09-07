import { describe, expect, it } from "vitest";
import { normalizeLocalImportAccounts } from "../src/integrations/localImportProtocol";

describe("local OAuth import protocol", () => {
  it("normalizes ChatGPT Auth and keeps safe account metadata", () => {
    const [account] = normalizeLocalImportAccounts([
      {
        email: "paid@example.com",
        auth_mode: "oauth",
        account_id: "acct-1",
        user_id: "user-1",
        plan_type: "plus",
        organization_id: "org-1",
        account_name: "Personal workspace",
        account_structure: "personal",
        subscription_active_until: "2099-01-01T00:00:00.000Z",
        raw_data: { access_token: "must-not-pass" },
        tokens: {
          id_token: "id-token",
          access_token: "access-token",
          refresh_token: "refresh-token"
        }
      }
    ]);

    expect(account).toEqual({
      email: "paid@example.com",
      auth_mode: "chatgpt",
      account_id: "acct-1",
      user_id: "user-1",
      plan_type: "plus",
      organization_id: "org-1",
      account_name: "Personal workspace",
      account_structure: "personal",
      subscription_active_until: "2099-01-01T00:00:00.000Z",
      tokens: {
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct-1"
      }
    });
  });
});
