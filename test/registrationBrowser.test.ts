import { describe, expect, it } from "vitest";
import {
  getIncognitoBrowserLaunches,
  launchIncognitoBrowser,
  type RegistrationBrowserSpawn
} from "../src/integrations/registrationBrowser";

describe("registration browser", () => {
  it("uses the private-window flag for the first supported Linux browser", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl: RegistrationBrowserSpawn = (command, args) => {
      calls.push({ command, args });
      return {
        once(event, listener) {
          if (event === "spawn") {
            listener();
          }
          return this;
        },
        unref() {}
      };
    };

    await expect(
      launchIncognitoBrowser("https://auth.openai.com/create-account", {
        platform: "linux",
        spawnImpl
      })
    ).resolves.toBe(true);

    expect(calls).toEqual([
      { command: "google-chrome", args: ["--incognito", "https://auth.openai.com/create-account"] }
    ]);
  });

  it("builds private launch candidates for the supported browser families", () => {
    const launches = getIncognitoBrowserLaunches("https://auth.openai.com/create-account", { platform: "linux" });

    expect(launches).toEqual([
      { command: "google-chrome", args: ["--incognito", "https://auth.openai.com/create-account"] },
      { command: "google-chrome-stable", args: ["--incognito", "https://auth.openai.com/create-account"] },
      { command: "chromium", args: ["--incognito", "https://auth.openai.com/create-account"] },
      { command: "chromium-browser", args: ["--incognito", "https://auth.openai.com/create-account"] },
      { command: "microsoft-edge", args: ["--inprivate", "https://auth.openai.com/create-account"] },
      { command: "firefox", args: ["--private-window", "https://auth.openai.com/create-account"] }
    ]);
  });
});
