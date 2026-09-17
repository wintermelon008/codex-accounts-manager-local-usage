import { describe, expect, it } from "vitest";
import {
  decryptSharingPayload,
  deriveSharingUserId,
  encryptSharingPayload,
  generateSharingKeyMaterial
} from "../src/sharing/crypto";
import { isSharedAccountQuotaExhausted } from "../src/sharing/accountSharingService";
import type { CodexAccountRecord } from "../src/core/types";

describe("account sharing envelope crypto", () => {
  it("recognizes explicit quota exhaustion without treating a transient API error as exhaustion", () => {
    const base = {
      id: "account",
      email: "account@example.com",
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    } satisfies CodexAccountRecord;
    expect(
      isSharedAccountQuotaExhausted({
        ...base,
        quotaError: { code: "usage_limit_exceeded", message: "usage limit", timestamp: 1 }
      })
    ).toBe(true);
    expect(
      isSharedAccountQuotaExhausted({
        ...base,
        quotaError: { code: "http_500", message: "API returned 500", timestamp: 1 }
      })
    ).toBe(false);
    expect(
      isSharedAccountQuotaExhausted({
        ...base,
        quotaSummary: {
          hourlyPercentage: 0,
          hourlyWindowPresent: true,
          weeklyPercentage: 80,
          weeklyWindowPresent: true,
          codeReviewPercentage: 0
        }
      })
    ).toBe(true);
  });

  it("encrypts for the target identity and rejects tampered envelopes", () => {
    const senderKeys = generateSharingKeyMaterial();
    const recipientKeys = generateSharingKeyMaterial();
    const senderUserId = deriveSharingUserId(senderKeys.identityPublicKey);
    const recipientUserId = deriveSharingUserId(recipientKeys.identityPublicKey);
    const payload = {
      schema: "codex-account-sharing-package/v1",
      leaseId: "lease-1",
      expiresAt: 1_800_000_000_000,
      accounts: [{ email: "friend@example.com", tokens: { access_token: "secret" } }]
    };

    const envelope = encryptSharingPayload(
      payload,
      senderKeys,
      senderUserId,
      recipientUserId,
      recipientKeys.encryptionPublicKey,
      1_700_000_000_000
    );

    expect(
      decryptSharingPayload(envelope, recipientKeys, recipientUserId, {
        userId: senderUserId,
        identityPublicKey: senderKeys.identityPublicKey
      })
    ).toEqual(payload);
    expect(() => decryptSharingPayload(envelope, senderKeys, senderUserId)).toThrow();

    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext}A` };
    expect(() =>
      decryptSharingPayload(tampered, recipientKeys, recipientUserId, {
        userId: senderUserId,
        identityPublicKey: senderKeys.identityPublicKey
      })
    ).toThrow(/signature|unable to authenticate|Unsupported state/u);
  });
});
