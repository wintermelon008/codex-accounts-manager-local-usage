import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { CodexTokens } from "../core/types";
import { tryAcquireSharedFileLease } from "./accountsWriteCoordinator";

const SECRET_PREFIX = "codex.account.";
const SECRET_FILE_VERSION = 1;
const SECRET_FILE_LOCK_LEASE_MS = 15_000;
const SECRET_FILE_LOCK_WAIT_MS = 5_000;

type SecretFile = {
  version: typeof SECRET_FILE_VERSION;
  values: Record<string, string>;
};

export class SecretStore {
  private fileQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly privateFilePath?: string
  ) {}

  async getTokens(accountId: string): Promise<CodexTokens | undefined> {
    const key = `${SECRET_PREFIX}${accountId}`;
    const privateRaw = await this.readPrivateValue(key);
    const raw = privateRaw ?? (await this.secrets.get(key));
    if (!raw) {
      return undefined;
    }
    if (privateRaw === undefined && this.privateFilePath) {
      await this.writePrivateValue(key, raw);
    }
    return JSON.parse(raw) as CodexTokens;
  }

  async setTokens(accountId: string, tokens: CodexTokens): Promise<void> {
    const key = `${SECRET_PREFIX}${accountId}`;
    const raw = JSON.stringify(tokens);
    if (this.privateFilePath) {
      await this.writePrivateValue(key, raw);
    }
    // Keep the VS Code SecretStorage mirror during the migration window. The
    // private file is the source used by new Manager instances; the mirror
    // keeps older installed builds and existing tests/clients compatible.
    await this.secrets.store(key, raw);
  }

  async deleteTokens(accountId: string): Promise<void> {
    const key = `${SECRET_PREFIX}${accountId}`;
    if (this.privateFilePath) {
      await this.deletePrivateValue(key);
    }
    await this.secrets.delete(key);
  }

  private async readPrivateValue(key: string): Promise<string | undefined> {
    if (!this.privateFilePath) {
      return undefined;
    }
    let document: SecretFile;
    try {
      document = JSON.parse(await readFile(this.privateFilePath, "utf8")) as SecretFile;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
    assertSecretFile(document, this.privateFilePath);
    return document.values[key];
  }

  private async writePrivateValue(key: string, value: string): Promise<void> {
    await this.withFileQueue(async () => {
      const document = await this.readPrivateDocument();
      document.values[key] = value;
      await this.writePrivateDocument(document);
    });
  }

  private async deletePrivateValue(key: string): Promise<void> {
    await this.withFileQueue(async () => {
      const document = await this.readPrivateDocument();
      if (!Object.prototype.hasOwnProperty.call(document.values, key)) {
        return;
      }
      delete document.values[key];
      await this.writePrivateDocument(document);
    });
  }

  private async readPrivateDocument(): Promise<SecretFile> {
    if (!this.privateFilePath) {
      return { version: SECRET_FILE_VERSION, values: {} };
    }
    try {
      const document = JSON.parse(await readFile(this.privateFilePath, "utf8")) as SecretFile;
      assertSecretFile(document, this.privateFilePath);
      return { version: SECRET_FILE_VERSION, values: { ...document.values } };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: SECRET_FILE_VERSION, values: {} };
      }
      throw error;
    }
  }

  private async writePrivateDocument(document: SecretFile): Promise<void> {
    if (!this.privateFilePath) {
      return;
    }
    const directory = path.dirname(this.privateFilePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.privateFilePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(temporaryPath, 0o600).catch(() => undefined);
      await rename(temporaryPath, this.privateFilePath);
      await chmod(this.privateFilePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withFileQueue(task: () => Promise<void>): Promise<void> {
    const previous = this.fileQueue;
    let release!: () => void;
    this.fileQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const lease = this.privateFilePath
      ? await tryAcquireSharedFileLease(
          `${this.privateFilePath}.write-lock`,
          SECRET_FILE_LOCK_LEASE_MS,
          SECRET_FILE_LOCK_WAIT_MS
        )
      : undefined;
    if (this.privateFilePath && !lease) {
      release();
      throw new Error("Private account credential store is busy; try again shortly");
    }
    try {
      await task();
    } finally {
      await lease?.release();
      release();
    }
  }
}

function assertSecretFile(value: SecretFile, filePath: string): asserts value is SecretFile {
  if (
    !value ||
    value.version !== SECRET_FILE_VERSION ||
    !value.values ||
    typeof value.values !== "object" ||
    Array.isArray(value.values) ||
    Object.entries(value.values).some(([key, item]) => !key || typeof item !== "string")
  ) {
    throw new Error(`Invalid private credential store: ${filePath}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
