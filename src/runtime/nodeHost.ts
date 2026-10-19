import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountsRepositoryContext } from "../storage/accounts";
import type { SecretStorageLike } from "../storage/secrets";
import { readAuthFile, writeAuthFile } from "../codex/authFile";

type KeyValueDocument = {
  version: 1;
  values: Record<string, unknown>;
};

/**
 * Small file-backed key/value store for non-secret daemon diagnostics.
 * Values are loaded before the host starts and every update is atomic.
 */
export class NodeJsonKeyValueStore {
  private values: Record<string, unknown> = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<KeyValueDocument>;
      if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== "object") {
        throw new Error(`Invalid daemon state file: ${this.filePath}`);
      }
      this.values = { ...parsed.values };
    } catch (error) {
      if (isMissingFileError(error)) {
        this.values = {};
        return;
      }
      throw error;
    }
  }

  keys(): readonly string[] {
    return Object.keys(this.values);
  }

  get<T>(key: string): T | undefined {
    const value = this.values[key];
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.values[key];
    } else {
      this.values[key] = structuredClone(value);
    }

    const snapshot: KeyValueDocument = {
      version: 1,
      values: structuredClone(this.values)
    };
    const task = this.writeChain
      .catch(() => undefined)
      .then(() => writeJsonAtomically(this.filePath, snapshot));
    this.writeChain = task;
    return task;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

/** A no-op SecretStorage mirror; the private credential file is authoritative. */
export const nodeSecretStorage: SecretStorageLike = {
  get: () => Promise.resolve(undefined),
  store: () => Promise.resolve(),
  delete: () => Promise.resolve()
};

export function createNodeAccountsContext(privateRoot: string): AccountsRepositoryContext {
  return {
    globalStorageUri: { fsPath: privateRoot },
    secrets: nodeSecretStorage,
    authFile: { readAuthFile, writeAuthFile }
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
