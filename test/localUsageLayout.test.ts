import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

describe("local usage dashboard placement and responsive guards", () => {
  it("keeps the local usage section after the saved-account grid in normal document flow", () => {
    const source = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const savedAccountsGridIndex = source.indexOf('<div class="accounts-grid">');
    const savedAccountsSectionEndIndex = source.indexOf("</section>", savedAccountsGridIndex);
    const localUsageIndex = source.indexOf("<LocalUsageSection");

    expect(savedAccountsGridIndex).toBeGreaterThan(-1);
    expect(savedAccountsSectionEndIndex).toBeGreaterThan(savedAccountsGridIndex);
    expect(localUsageIndex).toBeGreaterThan(savedAccountsGridIndex);
    expect(localUsageIndex).toBeGreaterThan(savedAccountsSectionEndIndex);
    expect(source.slice(localUsageIndex, localUsageIndex + 100)).not.toContain("style=");
  });

  it("contains narrow-window layout guards without changing shared account or modal selectors", () => {
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(stylesheet).toContain("@media (max-width: 1400px)");
    expect(stylesheet).toContain("@media (max-width: 1200px)");
    expect(stylesheet).toContain("@media (max-width: 920px)");
    expect(stylesheet).toContain("@media (max-width: 620px)");
    expect(stylesheet).toContain("@media (max-width: 520px)");
    expect(stylesheet).toContain(".local-usage-cards");
    expect(stylesheet).toContain(".local-usage-layout");
    expect(stylesheet).toContain(".local-usage-bar-row");
    expect(stylesheet).toContain(".local-usage-range-btn");
    expect(stylesheet).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");

    const localUsageStyles = stylesheet.slice(
      stylesheet.indexOf(".local-usage-section"),
      stylesheet.indexOf("@keyframes button-spin")
    );
    expect(localUsageStyles).not.toContain("position:");
    expect(localUsageStyles).not.toMatch(/\.(?:overview|toolbar|accounts|modal)-/);
    expect(localUsageStyles).toContain("font-size: 16px");
    expect(localUsageStyles).toContain("font-size: 14px");
  });

  it("keeps price between total and input, and exposes range controls in the dashboard and settings", () => {
    const section = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/localUsageSection.tsx"), "utf8");
    const settings = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/settingsOverlay.tsx"), "utf8");
    const cards = section.slice(
      section.indexOf('<div class="local-usage-cards">'),
      section.indexOf('<div class="local-usage-layout">')
    );

    expect(cards.indexOf("copy.localUsageTotal")).toBeLessThan(cards.indexOf("copy.localUsagePrice"));
    expect(cards.indexOf("copy.localUsagePrice")).toBeLessThan(cards.indexOf("copy.localUsageInput"));
    expect(section).toContain("<RangeSelector");
    expect(section).toContain("formatTokenAndPrice");
    expect(section).toContain("formatThreeHourRange");
    expect(section).toContain('const visibleModels = range.byModel.filter((row) => row.model !== "unknown")');
    expect(section).toContain('`${tokenText} (${formatCompactUsd(price.amountUsd)})`');
    expect(section).not.toContain('unpricedTokens > 0 ? "+"');
    expect(settings).toContain("localUsageDefaultRange");
    expect(settings).not.toContain("localUsageDefaultRangeDays");
    expect(settings).toContain("localUsageShowEquivalentPrice");
  });
});
