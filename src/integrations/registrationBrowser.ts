import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export type RegistrationBrowserLaunch = {
  command: string;
  args: string[];
};

export type RegistrationBrowserSpawnedProcess = {
  once(event: "spawn" | "error", listener: () => void): RegistrationBrowserSpawnedProcess;
  unref(): void;
};

export type RegistrationBrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" }
) => RegistrationBrowserSpawnedProcess;

export type RegistrationBrowserLaunchOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: RegistrationBrowserSpawn;
};

export function getIncognitoBrowserLaunches(
  url: string,
  options: RegistrationBrowserLaunchOptions = {}
): RegistrationBrowserLaunch[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const launches: RegistrationBrowserLaunch[] = [];
  const add = (command: string | undefined, flag: string): void => {
    if (command?.trim()) {
      launches.push({ command, args: [flag, url] });
    }
  };
  const addPath = (base: string | undefined, relativePath: string, flag: string): void => {
    if (base?.trim()) {
      add(path.join(base, relativePath), flag);
    }
  };

  if (platform === "win32") {
    addPath(env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe", "--incognito");
    addPath(env["PROGRAMFILES"], "Google/Chrome/Application/chrome.exe", "--incognito");
    addPath(env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe", "--incognito");
    addPath(env["LOCALAPPDATA"], "Microsoft/Edge/Application/msedge.exe", "--inprivate");
    addPath(env["PROGRAMFILES"], "Microsoft/Edge/Application/msedge.exe", "--inprivate");
    addPath(env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe", "--inprivate");
    addPath(env["PROGRAMFILES"], "Mozilla Firefox/firefox.exe", "-private-window");
    addPath(env["PROGRAMFILES(X86)"], "Mozilla Firefox/firefox.exe", "-private-window");
    add("chrome.exe", "--incognito");
    add("msedge.exe", "--inprivate");
    add("firefox.exe", "-private-window");
    return launches;
  }

  if (platform === "darwin") {
    addPath(homeDir, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--incognito");
    add("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--incognito");
    addPath(homeDir, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "--inprivate");
    add("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "--inprivate");
    addPath(homeDir, "Applications/Firefox.app/Contents/MacOS/firefox", "-private-window");
    add("/Applications/Firefox.app/Contents/MacOS/firefox", "-private-window");
    return launches;
  }

  add("google-chrome", "--incognito");
  add("google-chrome-stable", "--incognito");
  add("chromium", "--incognito");
  add("chromium-browser", "--incognito");
  add("microsoft-edge", "--inprivate");
  add("firefox", "--private-window");
  return launches;
}

export async function launchIncognitoBrowser(
  url: string,
  options: RegistrationBrowserLaunchOptions = {}
): Promise<boolean> {
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as RegistrationBrowserSpawn);
  for (const launch of getIncognitoBrowserLaunches(url, options)) {
    if (await trySpawn(launch, spawnImpl)) {
      return true;
    }
  }
  return false;
}

function trySpawn(launch: RegistrationBrowserLaunch, spawnImpl: RegistrationBrowserSpawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };

    try {
      const child = spawnImpl(launch.command, launch.args, {
        detached: true,
        stdio: "ignore"
      });
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
      child.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}
