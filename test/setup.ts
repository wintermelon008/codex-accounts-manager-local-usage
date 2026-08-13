import { vi } from "vitest";

vi.mock("vscode", () => ({
  env: {
    language: "en",
    clipboard: {
      writeText: vi.fn()
    },
    openExternal: vi.fn(async () => true)
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
    showInformationMessage: vi.fn()
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  RelativePattern: class RelativePattern {}
}));
