import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("extension manifest configuration", () => {
  it("keeps the packaged customization scope aligned with the reviewed manifest", () => {
    const root = path.resolve(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      codexAccountsLocalCustomization?: { feature?: string };
    };
    const customization = JSON.parse(fs.readFileSync(path.join(root, "local-customization.json"), "utf8")) as {
      feature?: string;
    };

    expect(manifest.codexAccountsLocalCustomization?.feature).toBe("local-enhancements");
    expect(manifest.codexAccountsLocalCustomization?.feature).toBe(customization.feature);
  });

  it("declares the auto switch reload window setting", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };

    const property = manifest.contributes?.configuration?.properties?.["codexAccounts.autoSwitchReloadWindowEnabled"];

    expect(property).toBeTruthy();
    expect(property).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(property?.markdownDescription).toContain("Automatically reload");
  });

  it("declares persisted local usage range and equivalent-price settings", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<
            string,
            { type?: string; default?: unknown; enum?: unknown[]; markdownDescription?: string }
          >;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties;

    expect(properties?.["codexAccounts.localUsageDefaultRange"]).toMatchObject({
      type: "string",
      default: "7d",
      enum: ["24h", "7d", "14d"]
    });
    expect(properties?.["codexAccounts.localUsageShowEquivalentPrice"]).toMatchObject({
      type: "boolean",
      default: true
    });
    expect(properties?.["codexAccounts.localUsageShowEquivalentPrice"]?.markdownDescription).toContain(
      "Codex subscription bill"
    );
  });

  it("declares seamless behavior, runtime installation, quota-band balancing, and rollback commands", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown }>;
        };
        commands?: Array<{ command?: string; title?: string }>;
      };
    };
    const properties = manifest.contributes?.configuration?.properties;
    const commandIds = manifest.contributes?.commands?.map((command) => command.command);
    const commandTitles = manifest.contributes?.commands?.map((command) => command.title);

    expect(properties?.["codexAccounts.hotSwitchEnabled"]).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(properties?.["codexAccounts.seamlessSwitchEnabled"]).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(properties?.["codexAccounts.hotSwitchGraceSeconds"]).toMatchObject({
      type: "number",
      default: 60
    });
    expect(properties?.["codexAccounts.hotSwitchLongTurnPolicy"]).toMatchObject({
      type: "string",
      default: "defer"
    });
    expect(properties?.["codexAccounts.seamlessSwitchQuotaBandsEnabled"]).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(properties?.["codexAccounts.balanceByQuotaBandsEnabled"]).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(commandIds).toContain("codexAccounts.enableHotSwitch");
    expect(commandIds).toContain("codexAccounts.disableHotSwitch");
    expect(commandTitles).toContain("Codex Accounts: Install Experimental Seamless Runtime");
    expect(commandTitles).toContain("Codex Accounts: Remove Experimental Seamless Runtime");
  });
});
