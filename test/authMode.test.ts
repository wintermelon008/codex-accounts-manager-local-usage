import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexImportFile, writeAuthFile } from "../src/codex/authFile";
import { buildAccountStorageId, readCurrentAuthAccountStorageId } from "../src/utils/accountIdentity";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import { toSharedAccountJson } from "../src/storage/sharedAccounts";

function createTokens(): CodexTokens {
  return {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountId: "account-id"
  };
}

describe("Codex auth mode compatibility", () => {
  let tempCodexHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-mode-test-"));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempCodexHome;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    await fs.rm(tempCodexHome, { recursive: true, force: true });
  });

  it("omits auth_mode from auth.json for OAuth accounts", async () => {
    await writeAuthFile(createTokens());

    const authFile = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));

    // OAuth 账号不写 auth_mode（由 codex 根据 token 推断），避免 codex 新版拒绝 "chatgpt"。
    expect(authFile.auth_mode).toBeUndefined();
    expect(authFile.OPENAI_API_KEY).toBeNull();
    expect(authFile.tokens.access_token).toBe("access-token");
  });

  it("preserves official ChatGPT auth metadata when refreshing the same account", async () => {
    await fs.writeFile(
      path.join(tempCodexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "old-id-token",
          access_token: "old-access-token",
          refresh_token: "old-refresh-token",
          account_id: "account-id",
          oauth_provenance: { issuer: "https://auth.openai.com", client_id: "client-id" },
          login_owner_id: "login-owner-id"
        },
        last_refresh: "2026-11-06T00:00:00.000Z"
      }),
      "utf8"
    );

    await writeAuthFile(createTokens());

    const authFile = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));
    expect(authFile.auth_mode).toBe("chatgpt");
    expect(authFile.tokens.oauth_provenance).toEqual({
      issuer: "https://auth.openai.com",
      client_id: "client-id"
    });
    expect(authFile.tokens.login_owner_id).toBe("login-owner-id");
    expect(authFile.tokens.id_token).toBe("id-token");
    expect(authFile.tokens.access_token).toBe("access-token");
    expect(authFile.tokens.refresh_token).toBe("refresh-token");

    await writeAuthFile({ ...createTokens(), refreshToken: undefined });
    const sanitizedAuthFile = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));
    expect(sanitizedAuthFile.auth_mode).toBe("chatgpt");
    expect(sanitizedAuthFile.tokens.oauth_provenance).toEqual({
      issuer: "https://auth.openai.com",
      client_id: "client-id"
    });
    expect(sanitizedAuthFile.tokens.login_owner_id).toBe("login-owner-id");
    expect(sanitizedAuthFile.tokens.refresh_token).toBe("");
  });

  it("keeps access-only credentials parseable by Codex and restores the same account after reload", async () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({
      email: "follower@example.invalid",
      "https://api.openai.com/auth": { chatgpt_account_id: "follower-workspace" }
    })}.test`;
    const tokens = { idToken: token, accessToken: token, accountId: "follower-workspace" };

    await writeAuthFile(tokens);
    const reloaded = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));

    // Codex TokenData requires a string here even when the follower has no
    // refresh credential. An absent/null field makes the entire login unreadable.
    expect(reloaded.tokens.refresh_token).toBe("");
    expect(reloaded.tokens.access_token).toBe(token);
    expect(await readCurrentAuthAccountStorageId()).toBe(
      buildAccountStorageId("follower@example.invalid", "follower-workspace")
    );
    expect(buildCodexImportFile(tokens).tokens?.refresh_token).toBe("");
  });

  it("preserves external auth metadata across an account switch", async () => {
    await fs.writeFile(
      path.join(tempCodexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "old-id-token",
          access_token: "old-access-token",
          account_id: "old-account-id",
          oauth_provenance: { issuer: "https://auth.openai.com" },
          login_owner_id: "old-login-owner"
        }
      }),
      "utf8"
    );

    await writeAuthFile({ ...createTokens(), accountId: "new-account-id" });

    const authFile = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));
    expect(authFile.auth_mode).toBe("chatgpt");
    expect(authFile.tokens.oauth_provenance).toEqual({ issuer: "https://auth.openai.com" });
    expect(authFile.tokens.login_owner_id).toBe("old-login-owner");
    expect(authFile.tokens.account_id).toBe("new-account-id");
  });

  it("exports shared OAuth accounts as ChatGPT Auth", () => {
    const account: CodexAccountRecord = {
      id: "account",
      email: "dev@example.com",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000
    };

    const shared = toSharedAccountJson(account, createTokens());

    expect(shared.auth_mode).toBe("chatgpt");
  });
});
