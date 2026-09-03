import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type SessionKind = "ordinary" | "supergoal" | "loop-goal";
export type SessionStatus = "active" | "idle" | "completed" | "blocked" | "unknown";

export type SessionRecord = {
  conversationId: string;
  kind: SessionKind;
  project?: string;
  goalId?: string;
  runId?: string;
  nativeThreadId?: string;
  title?: string;
  status: SessionStatus;
  artifactLocator?: string;
  externalRefs: string[];
  createdAt: number;
  updatedAt: number;
};

export type SessionRegistration = {
  conversationId?: string;
  kind?: SessionKind;
  project?: string;
  goalId?: string;
  runId?: string;
  nativeThreadId?: string;
  title?: string;
  status?: SessionStatus;
  artifactLocator?: string;
  externalRefs?: readonly string[];
};

export type SessionListFilter = {
  project?: string;
  goalId?: string;
  runId?: string;
  kind?: SessionKind;
  status?: SessionStatus;
  query?: string;
};

type SessionRegistryDocument = SessionRecord[];

/**
 * Native Codex transcripts remain in CODEX_HOME; this file only connects
 * user-facing conversations to native threads and goal runs.
 */
export class SessionHub {
  private initialized = false;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await this.readDocument();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.writeDocument([]);
    }
    this.initialized = true;
  }

  async register(input: SessionRegistration): Promise<SessionRecord> {
    const document = await this.load();
    const now = Date.now();
    const conversationId = nonempty(input.conversationId) ?? randomUUID();
    const existing = document.find((session) => session.conversationId === conversationId);
    const record: SessionRecord = {
      conversationId,
      kind: input.kind ?? existing?.kind ?? "ordinary",
      status: input.status ?? existing?.status ?? "idle",
      externalRefs: uniqueStrings(input.externalRefs ?? existing?.externalRefs ?? []),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(chooseText(input.project, existing?.project) ? { project: chooseText(input.project, existing?.project) } : {}),
      ...(chooseText(input.goalId, existing?.goalId) ? { goalId: chooseText(input.goalId, existing?.goalId) } : {}),
      ...(chooseText(input.runId, existing?.runId) ? { runId: chooseText(input.runId, existing?.runId) } : {}),
      ...(chooseText(input.nativeThreadId, existing?.nativeThreadId)
        ? { nativeThreadId: chooseText(input.nativeThreadId, existing?.nativeThreadId) }
        : {}),
      ...(chooseText(input.title, existing?.title) ? { title: chooseText(input.title, existing?.title) } : {}),
      ...(chooseText(input.artifactLocator, existing?.artifactLocator)
        ? { artifactLocator: chooseText(input.artifactLocator, existing?.artifactLocator) }
        : {})
    };
    const index = document.findIndex((session) => session.conversationId === conversationId);
    if (index >= 0) {
      document[index] = record;
    } else {
      document.push(record);
    }
    await this.writeDocument(document);
    return record;
  }

  async list(filter: SessionListFilter = {}): Promise<SessionRecord[]> {
    const document = await this.load();
    const query = nonempty(filter.query)?.toLocaleLowerCase();
    return document
      .filter((session) => {
        if (filter.project && session.project !== filter.project) {
          return false;
        }
        if (filter.goalId && session.goalId !== filter.goalId) {
          return false;
        }
        if (filter.runId && session.runId !== filter.runId) {
          return false;
        }
        if (filter.kind && session.kind !== filter.kind) {
          return false;
        }
        if (filter.status && session.status !== filter.status) {
          return false;
        }
        if (!query) {
          return true;
        }
        return [
          session.conversationId,
          session.nativeThreadId,
          session.project,
          session.goalId,
          session.runId,
          session.title,
          ...session.externalRefs
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(query));
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({ ...session, externalRefs: [...session.externalRefs] }));
  }

  async get(conversationId: string): Promise<SessionRecord | undefined> {
    const document = await this.load();
    const session = document.find((item) => item.conversationId === conversationId.trim());
    return session ? { ...session, externalRefs: [...session.externalRefs] } : undefined;
  }

  async locate(value: string): Promise<SessionRecord | undefined> {
    const document = await this.load();
    const needle = value.trim();
    const session = document.find(
      (item) =>
        item.conversationId === needle ||
        item.nativeThreadId === needle ||
        item.goalId === needle ||
        item.runId === needle ||
        item.externalRefs.includes(needle)
    );
    return session ? { ...session, externalRefs: [...session.externalRefs] } : undefined;
  }

  private async load(): Promise<SessionRegistryDocument> {
    if (!this.initialized) {
      await this.init();
    }
    return this.readDocument();
  }

  private async readDocument(): Promise<SessionRegistryDocument> {
    const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!isRegistryDocument(value)) {
      throw new Error(`Invalid session hub registry: ${this.filePath}`);
    }
    return value;
  }

  private async writeDocument(document: SessionRegistryDocument): Promise<void> {
    const temporaryPath = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export function resolveSessionRegistryPath(): string {
  return path.join(os.homedir(), ".local", "state", "codex-accounts-manager", "session-registry.json");
}

function chooseText(next: string | undefined, previous: string | undefined): string | undefined {
  return nonempty(next) ?? nonempty(previous);
}

function nonempty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRegistryDocument(value: unknown): value is SessionRegistryDocument {
  return Array.isArray(value);
}
