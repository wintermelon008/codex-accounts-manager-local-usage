import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, vi } from "vitest";

const testDataRoot = mkdtempSync(path.join(os.tmpdir(), "codex-accounts-vitest-"));

// Never allow tests to inherit the Manager's real private state directory.
delete process.env.CODEX_ACCOUNTS_PRIVATE_DIR;
process.env.AIDECK_DATA_DIR = path.join(testDataRoot, "aideck-data");

afterAll(() => {
  rmSync(testDataRoot, { recursive: true, force: true });
});

vi.mock("vscode", () => ({
  env: {
    language: "en",
    clipboard: {
      writeText: vi.fn()
    },
    openExternal: vi.fn(async () => true),
    asExternalUri: vi.fn(async (uri: unknown) => uri)
  },
  extensions: {
    getExtension: vi.fn()
  },
  Uri: {
    parse: vi.fn((value: string) => ({ toString: () => value }))
  },
  commands: {
    executeCommand: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn(),
      inspect: vi.fn()
    })),
    createFileSystemWatcher: vi.fn(),
    onDidChangeConfiguration: vi.fn()
  },
  window: {
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn()
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  RelativePattern: class RelativePattern {}
}));
