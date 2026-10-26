import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getManagerMailboxSettingsPath,
  readManagerMailboxEnabled,
  writeManagerMailboxEnabled
} from "../src/infrastructure/config/managerMailboxSettings";

describe("Manager Mailbox settings", () => {
  it("defaults to undefined until the Dashboard publishes an explicit value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-mailbox-settings-"));
    try {
      await expect(readManagerMailboxEnabled(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the unified switch atomically and rejects malformed state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-mailbox-settings-"));
    try {
      await writeManagerMailboxEnabled(root, false);
      await expect(readManagerMailboxEnabled(root)).resolves.toBe(false);
      await writeManagerMailboxEnabled(root, true);
      await expect(readManagerMailboxEnabled(root)).resolves.toBe(true);

      const filePath = getManagerMailboxSettingsPath(root);
      await expect(readFile(filePath, "utf8")).resolves.toContain(
        '"schema":"codex-accounts-manager-mailbox-settings/v1"'
      );
      await expect(readFile(filePath, "utf8")).resolves.toContain('"enabled":true');

      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(filePath, JSON.stringify({ schema: "wrong", enabled: true }), "utf8")
      );
      await expect(readManagerMailboxEnabled(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
