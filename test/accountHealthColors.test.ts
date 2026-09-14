import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Check the shipped palette contract; this is not browser/pixel verification.
describe("swapped renewal health palette", () => {
  it.each(["quotaSummary.css", "details.css"])("ships cyan usable and yellow unknown palettes in %s", (file) => {
    const css = readFileSync(new URL(`../media/webview/${file}`, import.meta.url), "utf8");
    expect(css).toContain("--health-usable-color: #06b6d4");
    expect(css).toContain("--health-usable-color: #0e7490");
    expect(css).toContain("--health-unknown-color: #d29922");
    expect(css).toContain("--health-unknown-color: #ca8a04");
    expect(css).toContain(".health-usable");
    expect(css).toContain(".health-unknown");
  });
});
