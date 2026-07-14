import { describe, expect, it } from "vitest";
import { hasCompatibleLocalUsageManifest } from "../src/presentation/dashboard/localUsageCompatibility";

const manifest = {
  schemaVersion: 1,
  feature: "local-usage-dashboard",
  extensionId: "wannanbigpig.codex-accounts-manager",
  localBuildVersion: "0.1.16-local.3",
  upstream: {
    version: "0.1.16",
    commit: "4b1689deafd2d303700c5cc26e6fd285979634e4"
  }
};

const packageJson = {
  publisher: "wannanbigpig",
  name: "codex-accounts-manager",
  version: "0.1.16-local.3"
};

describe("hasCompatibleLocalUsageManifest", () => {
  it("enables the feature only for the reviewed local package identity", () => {
    expect(hasCompatibleLocalUsageManifest(manifest, packageJson)).toBe(true);
  });

  it("fails closed after a package version mismatch", () => {
    expect(hasCompatibleLocalUsageManifest(manifest, { ...packageJson, version: "0.1.17" })).toBe(false);
  });
});
