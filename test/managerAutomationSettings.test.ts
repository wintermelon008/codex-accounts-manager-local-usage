import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getManagerAutomationSettingsPath,
  readManagerAutomationSettings,
  writeManagerAutomationSettings
} from "../src/infrastructure/config/managerAutomationSettings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createPrivateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-manager-automation-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("shared Manager automation settings", () => {
  it("round-trips the Dashboard setting atomically", async () => {
    const root = await createPrivateRoot();

    await writeManagerAutomationSettings(root, true);

    await expect(readManagerAutomationSettings(root)).resolves.toBe(true);
    await expect(readFile(getManagerAutomationSettingsPath(root), "utf8")).resolves.toContain(
      '"schema":"codex-accounts-manager-automation-settings/v1"'
    );
    await expect(stat(getManagerAutomationSettingsPath(root))).resolves.toMatchObject({ mode: 0o100600 });
  });

  it("returns undefined for missing or malformed state", async () => {
    const root = await createPrivateRoot();
    const settingsPath = getManagerAutomationSettingsPath(root);

    await expect(readManagerAutomationSettings(root)).resolves.toBeUndefined();
    await writeFile(settingsPath, "not-json", "utf8");
    await expect(readManagerAutomationSettings(root)).resolves.toBeUndefined();
    await writeFile(
      settingsPath,
      JSON.stringify({ schema: "codex-accounts-manager-automation-settings/v1", autoStartQuotaCountdown: "yes" }),
      "utf8"
    );
    await expect(readManagerAutomationSettings(root)).resolves.toBeUndefined();
  });
});
