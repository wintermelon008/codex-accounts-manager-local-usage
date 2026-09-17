import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from "node:crypto";

export const SHARING_ENVELOPE_SCHEMA = "codex-account-sharing-envelope/v1";
const SHARING_KDF_INFO = Buffer.from("codex-account-sharing/v1");

export type SharingKeyMaterial = {
  identityPrivateKey: string;
  identityPublicKey: string;
  encryptionPrivateKey: string;
  encryptionPublicKey: string;
};

export type SharingEnvelope = {
  schema: typeof SHARING_ENVELOPE_SCHEMA;
  senderUserId: string;
  recipientUserId: string;
  senderIdentityPublicKey: string;
  ephemeralPublicKey: string;
  salt: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
  createdAt: number;
  signature: string;
};

export function generateSharingKeyMaterial(): SharingKeyMaterial {
  const identity = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    identityPrivateKey: encodeKey(identity.privateKey, "pkcs8"),
    identityPublicKey: encodeKey(identity.publicKey, "spki"),
    encryptionPrivateKey: encodeKey(encryption.privateKey, "pkcs8"),
    encryptionPublicKey: encodeKey(encryption.publicKey, "spki")
  };
}

export function deriveSharingUserId(identityPublicKey: string): string {
  const digest = createHash("sha256").update(identityPublicKey).digest("base64url");
  return `rw_${digest.slice(0, 24)}`;
}

export function encryptSharingPayload(
  payload: unknown,
  keys: SharingKeyMaterial,
  senderUserId: string,
  recipientUserId: string,
  recipientEncryptionPublicKey: string,
  now = Date.now()
): SharingEnvelope {
  const ephemeral = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: decodePublicKey(recipientEncryptionPublicKey)
  });
  const salt = randomBytes(16);
  const key = deriveEncryptionKey(sharedSecret, salt);
  const nonce = randomBytes(12);
  const unsigned: Omit<SharingEnvelope, "signature"> = {
    schema: SHARING_ENVELOPE_SCHEMA,
    senderUserId,
    recipientUserId,
    senderIdentityPublicKey: keys.identityPublicKey,
    ephemeralPublicKey: encodeKey(ephemeral.publicKey, "spki"),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: "",
    ciphertext: "",
    createdAt: now
  };
  const aad = associatedData(unsigned);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  unsigned.ciphertext = ciphertext.toString("base64url");
  unsigned.authTag = cipher.getAuthTag().toString("base64url");
  return {
    ...unsigned,
    signature: sign(null, signingBytes(unsigned), decodePrivateKey(keys.identityPrivateKey)).toString("base64url")
  };
}

export function decryptSharingPayload(
  envelope: SharingEnvelope,
  keys: SharingKeyMaterial,
  expectedRecipientUserId: string,
  expectedSender?: { userId: string; identityPublicKey: string }
): unknown {
  if (
    envelope.schema !== SHARING_ENVELOPE_SCHEMA ||
    envelope.recipientUserId !== expectedRecipientUserId ||
    typeof envelope.signature !== "string"
  ) {
    throw new Error("sharing envelope identity is invalid");
  }
  if (
    expectedSender &&
    (envelope.senderUserId !== expectedSender.userId ||
      envelope.senderIdentityPublicKey !== expectedSender.identityPublicKey)
  ) {
    throw new Error("sharing envelope sender is not trusted");
  }
  const senderPublicKey = decodePublicKey(envelope.senderIdentityPublicKey);
  if (!verify(null, signingBytesWithoutSignature(envelope), senderPublicKey, decodeBase64Url(envelope.signature))) {
    throw new Error("sharing envelope signature is invalid");
  }
  const sharedSecret = diffieHellman({
    privateKey: decodePrivateKey(keys.encryptionPrivateKey),
    publicKey: decodePublicKey(envelope.ephemeralPublicKey)
  });
  const key = deriveEncryptionKey(sharedSecret, decodeBase64Url(envelope.salt));
  const nonce = decodeBase64Url(envelope.nonce);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(unsignedEnvelope(envelope)));
  decipher.setAuthTag(decodeBase64Url(envelope.authTag));
  const plaintext = Buffer.concat([decipher.update(decodeBase64Url(envelope.ciphertext)), decipher.final()]).toString(
    "utf8"
  );
  return JSON.parse(plaintext) as unknown;
}

function deriveEncryptionKey(sharedSecret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, SHARING_KDF_INFO, 32));
}

function associatedData(value: Omit<SharingEnvelope, "signature">): Buffer {
  return Buffer.from(
    stableStringify({
      schema: value.schema,
      senderUserId: value.senderUserId,
      recipientUserId: value.recipientUserId,
      senderIdentityPublicKey: value.senderIdentityPublicKey,
      ephemeralPublicKey: value.ephemeralPublicKey,
      salt: value.salt,
      nonce: value.nonce,
      createdAt: value.createdAt
    })
  );
}

function signingBytes(value: Omit<SharingEnvelope, "signature">): Buffer {
  return Buffer.from(stableStringify(value));
}

function signingBytesWithoutSignature(value: SharingEnvelope): Buffer {
  return signingBytes(unsignedEnvelope(value));
}

function unsignedEnvelope(value: SharingEnvelope): Omit<SharingEnvelope, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function encodeKey(key: KeyObject, type: "spki" | "pkcs8"): string {
  return key.export({ type, format: "der" }).toString("base64url");
}

function decodePublicKey(value: string): KeyObject {
  return createPublicKey({ key: decodeBase64Url(value), type: "spki", format: "der" });
}

function decodePrivateKey(value: string): KeyObject {
  return createPrivateKey({ key: decodeBase64Url(value), type: "pkcs8", format: "der" });
}

function decodeBase64Url(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("sharing envelope encoding is invalid");
  }
  return Buffer.from(value, "base64url");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
