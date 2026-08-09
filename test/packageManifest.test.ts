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
            {
              type?: string;
              default?: unknown;
              enum?: unknown[];
              items?: { type?: string; enum?: unknown[] };
              markdownDescription?: string;
            }
          >;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties;

    expect(properties?.["codexAccounts.localUsageDefaultRange"]).toMatchObject({
      type: "string",
      default: "7d",
      enum: ["7d", "14d"]
    });
    expect(properties?.["codexAccounts.localUsageEnabledRanges"]).toMatchObject({
      type: "array",
      default: ["24h"]
    });
    expect(properties?.["codexAccounts.localUsageEnabledRanges"]?.items).toMatchObject({
      type: "string",
      enum: ["24h", "3d", "7d", "14d", "7w", "7m"]
    });
    expect(properties?.["codexAccounts.localUsageShowEquivalentPrice"]).toMatchObject({
      type: "boolean",
      default: true
    });
    expect(properties?.["codexAccounts.localUsageShowEquivalentPrice"]?.markdownDescription).toContain(
      "Codex subscription bill"
    );
  });

  it("keeps the local import inbox opt-in by default", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };
    const property = manifest.contributes?.configuration?.properties?.["codexAccounts.localImportInboxEnabled"];

    expect(property).toMatchObject({ type: "boolean", default: false });
    expect(property?.markdownDescription).toContain("does not create, watch, or import");
  });

  it("keeps optional provider configuration out of the Manager manifest", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties;

    const vendorMarker = ["sub2", "api"].join("");

    expect(Object.keys(properties ?? {}).some((key) => key.toLowerCase().includes(vendorMarker))).toBe(false);
  });

  it("declares seamless behavior, runtime installation, quota-band balancing, and rollback commands", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; enum?: unknown[] }>;
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
    expect(properties?.["codexAccounts.seamlessSwitchLowQuotaEnabled"]).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(properties?.["codexAccounts.seamlessSwitchQuotaBandSize"]).toMatchObject({
      type: "number",
      default: 20,
      enum: [20, 25, 33, 50]
    });
    expect(properties?.["codexAccounts.seamlessSwitchThreshold"]).toMatchObject({
      type: "number",
      default: 3,
      enum: [0, 1, 3, 5]
    });
    expect(properties?.["codexAccounts.seamlessSwitchReserveThreshold"]).toBeUndefined();
    expect(properties?.["codexAccounts.seamlessSwitchEmergencySwitchEnabled"]).toBeUndefined();
    expect(properties?.["codexAccounts.seamlessSwitchGroupAVisible"]).toMatchObject({
      type: "boolean",
      default: true
    });
    expect(properties?.["codexAccounts.seamlessSwitchGroupBVisible"]).toMatchObject({
      type: "boolean",
      default: true
    });
    expect(properties?.["codexAccounts.seamlessSwitchGroupCVisible"]).toMatchObject({
      type: "boolean",
      default: true
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
