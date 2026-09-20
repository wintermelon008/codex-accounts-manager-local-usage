import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ATTACHMENT_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const FILENAME_MAX_LENGTH = 180;

/**
 * Session attachments are Gateway-owned temporary inputs. They are kept out
 * of the Workbench SQLite/data-service lifecycle and are addressed by opaque
 * ids so callers never need to send binary data inside a session JSON body.
 */
export class GatewayAttachmentStore {
  #root;
  #ttlMs;
  #maxBytes;
  #now;
  #items = new Map();

  constructor({ stateDir, ttlMs = DEFAULT_TTL_MS, maxBytes = DEFAULT_MAX_BYTES, now = () => Date.now() }) {
    this.#root = path.join(stateDir, "attachments");
    this.#ttlMs = ttlMs;
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  get maxBytes() {
    return this.#maxBytes;
  }

  async init() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ATTACHMENT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(this.#root, entry.name, "metadata.json"), "utf8"));
        if (!isMetadata(metadata) || metadata.expiresAt <= this.#now()) {
          await this.#removeDirectory(entry.name);
          continue;
        }
        this.#items.set(metadata.id, metadata);
      } catch {
        await this.#removeDirectory(entry.name).catch(() => undefined);
      }
    }
  }

  async create({ filename, mimeType, bytes, publicBaseUrl }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (buffer.length === 0) throw attachmentError("附件内容不能为空", 400);
    if (buffer.length > this.#maxBytes) throw attachmentError("附件超过 Gateway 大小限制", 413);

    const id = randomUUID();
    const now = this.#now();
    const metadata = {
      id,
      filename: normalizeFilename(filename),
      mimeType: normalizeMimeType(mimeType),
      size: buffer.length,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      accessToken: randomBytes(32).toString("base64url"),
      storageName: `payload${storageExtension(filename, mimeType)}`,
      url: ""
    };
    metadata.url = buildAttachmentUrl(publicBaseUrl, id, metadata.accessToken);
    const directory = path.join(this.#root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(directory, metadata.storageName), buffer, { flag: "wx", mode: 0o600 });
      await writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      this.#items.set(id, metadata);
      await this.cleanupExpired();
      return publicAttachment(metadata);
    } catch (error) {
      await this.#removeDirectory(id).catch(() => undefined);
      throw error;
    }
  }

  get(id) {
    if (!isAttachmentId(id)) return undefined;
    const metadata = this.#items.get(id);
    if (!metadata || metadata.expiresAt <= this.#now()) return undefined;
    return structuredClone(metadata);
  }

  resolve(id) {
    const metadata = this.get(id);
    if (!metadata) return undefined;
    return {
      ...publicAttachment(metadata),
      path: path.join(this.#root, id, metadata.storageName),
      accessToken: metadata.accessToken
    };
  }

  isAccessTokenValid(id, token) {
    const metadata = this.get(id);
    return Boolean(metadata && typeof token === "string" && token.length > 0 && token === metadata.accessToken);
  }

  async read(id) {
    const metadata = this.get(id);
    if (!metadata) return undefined;
    return { metadata: publicAttachment(metadata), bytes: await readFile(path.join(this.#root, id, metadata.storageName)) };
  }

  async remove(id) {
    if (!isAttachmentId(id)) return false;
    const existed = this.#items.delete(id);
    await this.#removeDirectory(id).catch(() => undefined);
    return existed;
  }

  async removeMany(ids) {
    for (const id of new Set(ids ?? [])) await this.remove(id);
  }

  async cleanupExpired() {
    const now = this.#now();
    for (const [id, metadata] of this.#items) {
      if (metadata.expiresAt <= now) await this.remove(id);
    }
  }

  async #removeDirectory(id) {
    this.#items.delete(id);
    await rm(path.join(this.#root, id), { recursive: true, force: true });
  }
}

export function attachmentError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function isAttachmentId(value) {
  return typeof value === "string" && ATTACHMENT_ID_PATTERN.test(value);
}

function publicAttachment(metadata) {
  return {
    id: metadata.id,
    filename: metadata.filename,
    mimeType: metadata.mimeType,
    size: metadata.size,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    url: metadata.url
  };
}

function isMetadata(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    isAttachmentId(value.id) &&
    typeof value.filename === "string" &&
    typeof value.mimeType === "string" &&
    MIME_TYPE_PATTERN.test(value.mimeType) &&
    Number.isSafeInteger(value.size) &&
    Number.isFinite(value.createdAt) &&
    Number.isFinite(value.expiresAt) &&
    typeof value.accessToken === "string" &&
    typeof value.storageName === "string" &&
    /^payload\.[a-z0-9][a-z0-9._-]{0,15}$/iu.test(value.storageName) &&
    typeof value.url === "string"
  );
}

function normalizeFilename(value) {
  const filename = typeof value === "string" ? value.trim() : "";
  const safe = filename.replace(/[\\/\0\r\n]+/gu, "_").slice(0, FILENAME_MAX_LENGTH);
  return safe || "attachment";
}

function normalizeMimeType(value) {
  const mimeType = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  return MIME_TYPE_PATTERN.test(mimeType) ? mimeType : "application/octet-stream";
}

function storageExtension(filename, mimeType) {
  const filenameExtension = path.extname(normalizeFilename(filename)).toLowerCase();
  if (/^\.[a-z0-9][a-z0-9._-]{0,15}$/iu.test(filenameExtension)) return filenameExtension;
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json"
  }[mimeType] ?? ".bin";
}

function buildAttachmentUrl(publicBaseUrl, id, accessToken) {
  const relative = `/v1/attachments/${encodeURIComponent(id)}${accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : ""}`;
  if (typeof publicBaseUrl !== "string" || !publicBaseUrl.trim()) return relative;
  try {
    return new URL(relative, `${publicBaseUrl.replace(/\/+$/u, "")}/`).toString();
  } catch {
    return relative;
  }
}
