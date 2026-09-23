import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/storage/secrets";
import type { CodexTokens } from "../src/core/types";

const tokens: CodexTokens = {
  idToken: "id-token",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accountId: "account-1"
};

describe("private account credential store", () => {
  it("persists credentials in the private file and reads legacy SecretStorage values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-private-secret-store-"));
    try {
      const values = new Map<string, string>();
      const secrets = {
        get: async (key: string) => values.get(key),
        store: async (key: string, value: string) => void values.set(key, value),
        delete: async (key: string) => void values.delete(key)
      };
      const filePath = path.join(root, "accounts-secrets.v1.json");
      const store = new SecretStore(secrets as never, filePath);

      values.set("codex.account.account-1", JSON.stringify(tokens));
      await expect(store.getTokens("account-1")).resolves.toEqual(tokens);
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
        version: 1,
        values: { "codex.account.account-1": JSON.stringify(tokens) }
      });

      const replacement = { ...tokens, refreshToken: "new-refresh-token" };
      await store.setTokens("account-1", replacement);
      expect(await store.getTokens("account-1")).toEqual(replacement);
      await store.deleteTokens("account-1");
      await expect(store.getTokens("account-1")).resolves.toBeUndefined();

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
