import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as vscode from "vscode";
import { prepareOAuthLoginSession, runPreparedOAuthLoginSession } from "../src/auth/oauth";

describe("OAuth callback listener startup", () => {
  it("does not open the browser when the callback port is already occupied", async () => {
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

      vi.mocked(vscode.env.openExternal).mockClear();
      await expect(
        runPreparedOAuthLoginSession(prepareOAuthLoginSession(address.port))
      ).rejects.toThrow("Automatic OAuth callback listener is unavailable");
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
