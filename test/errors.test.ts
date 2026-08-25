import { describe, expect, it } from "vitest";
import { APIError, formatApiErrorMessage, getErrorMessage } from "../src/core/errors";

describe("API error messages", () => {
  it("keeps useful server diagnostics while removing account and token values", () => {
    const body = JSON.stringify({
      error: {
        code: "invalid_grant",
        message: "refresh token for dev@example.com was rejected: eyJheader.payload.signature"
      }
    });

    const message = formatApiErrorMessage("Token refresh failed", 401, body);

    expect(message).toContain("invalid_grant");
    expect(message).toContain("[redacted-email]");
    expect(message).toContain("[redacted-token]");
    expect(message).not.toContain("dev@example.com");
    expect(message).not.toContain("eyJheader.payload.signature");
  });

  it("does not copy a non-JSON response into the user-facing message", () => {
    const message = formatApiErrorMessage("Quota request failed", 502, "private response body");

    expect(message).toBe("Quota request failed (502)");
    expect(message).not.toContain("private response body");
  });

  it("returns the already-safe API error message through the shared error accessor", () => {
    const error = new APIError(
      formatApiErrorMessage("Profile request failed", 403, JSON.stringify({ detail: "Denied" })),
      {
        statusCode: 403,
        responseBody: JSON.stringify({ detail: "Denied" })
      }
    );

    expect(getErrorMessage(error)).toBe("Profile request failed (403): Denied");
  });
});
