import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as vscode from "vscode";
import { prepareOAuthLoginSession, runPreparedOAuthLoginSession } from "../src/auth/oauth";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/utils/network", () => ({
  fetchWithTimeout: fetchWithTimeoutMock
}));

describe("OAuth callback listener startup", () => {
  it("keeps the registered callback port when the preferred port is occupied", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = blocker.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to determine the callback test port");
      }

      const openExternal = vi.mocked(vscode.env.openExternal);
      openExternal.mockClear();

      const session = prepareOAuthLoginSession(address.port);
      await expect(runPreparedOAuthLoginSession(session)).rejects.toThrow(
        "Automatic OAuth callback listener is unavailable"
      );
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      fetchWithTimeoutMock.mockReset();
      await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps the fixed callback visible so Remote-SSH can forward it", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });

    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine the callback test port");
    }
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));

    try {
      fetchWithTimeoutMock.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            id_token: "test-id-token",
            access_token: "test-access-token",
            refresh_token: "test-refresh-token"
          })
      });

      const originalRedirectUri = `http://localhost:${address.port}/auth/callback`;
      const openExternal = vi.mocked(vscode.env.openExternal);
      vi.mocked(vscode.env.asExternalUri).mockImplementationOnce(async () =>
        vscode.Uri.parse("http://localhost:1457/auth/callback")
      );
      openExternal.mockClear();
      openExternal.mockImplementationOnce(async (uri) => {
        const authUrl = new URL(uri.toString());
        const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
        callbackUrl.searchParams.set("code", "test-code");
        callbackUrl.searchParams.set("state", authUrl.searchParams.get("state") ?? "");

        await new Promise<void>((resolve, reject) => {
          const request = http.get(
            {
              hostname: callbackUrl.hostname,
              port: Number(callbackUrl.port),
              path: `${callbackUrl.pathname}${callbackUrl.search}`
            },
            (response) => {
              response.resume();
              response.once("end", () => {
                expect(response.statusCode).toBe(200);
                resolve();
              });
            }
          );
          request.once("error", reject);
        });

        return true;
      });

      const session = prepareOAuthLoginSession(address.port);
      await expect(runPreparedOAuthLoginSession(session)).resolves.toEqual({
        idToken: "test-id-token",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token"
      });

      expect(openExternal).toHaveBeenCalledOnce();
      expect(vscode.env.asExternalUri).toHaveBeenCalledOnce();
      const openedAuthUrlText = openExternal.mock.calls[0][0].toString();
      expect(openedAuthUrlText).toContain(`redirect_uri=http://localhost:${address.port}/auth/callback`);
      const openedAuthUrl = new URL(openedAuthUrlText);
      expect(openedAuthUrl.searchParams.get("redirect_uri")).toBe(originalRedirectUri);
      expect(session.redirectUri).toBe(originalRedirectUri);
    } finally {
      fetchWithTimeoutMock.mockReset();
    }
  });

  it("accepts a forwarded loopback port for manual callback completion", async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          id_token: "test-id-token",
          access_token: "test-access-token",
          refresh_token: "test-refresh-token"
        })
    });

    const { completeOAuthLoginSession } = await import("../src/auth/oauth");
    const session = prepareOAuthLoginSession(1455);
    const callbackUrl = new URL("http://localhost:1457/auth/callback");
    callbackUrl.searchParams.set("code", "test-code");
    callbackUrl.searchParams.set("state", session.state);

    await expect(completeOAuthLoginSession(session, callbackUrl.toString())).resolves.toEqual({
      idToken: "test-id-token",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token"
    });

    const request = fetchWithTimeoutMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(request?.body).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
  });
});
