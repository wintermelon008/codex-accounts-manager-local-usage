"use strict";

const { ensureVirtualDisplay } = require("./virtual-display.cjs");

function resolveBrowserMode(env = process.env) {
  const requested = String(env.CODEX_MAILBOX_HEADLESS || "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(requested)) return "headless";
  if (["0", "false", "no"].includes(requested)) return "headed";
  return String(env.DISPLAY || "").trim() ? "headed" : "headless";
}

async function prepareBrowserEnvironment(env = process.env, { ensureDisplay = ensureVirtualDisplay } = {}) {
  const requested = String(env.CODEX_MAILBOX_HEADLESS || "").trim().toLowerCase();
  const launchEnv = { ...env };
  if (["1", "true", "yes"].includes(requested)) {
    return {
      mode: "headless",
      launchEnv,
      display: "",
      displayKind: "headless",
      interactive: false,
      release: async () => {}
    };
  }

  const configuredDisplay = String(env.DISPLAY || "").trim();
  if (configuredDisplay) {
    return {
      mode: "headed",
      launchEnv,
      display: configuredDisplay,
      displayKind: "external",
      interactive: true,
      release: async () => {}
    };
  }

  try {
    const virtualDisplay = await ensureDisplay();
    return {
      mode: "headed",
      launchEnv: { ...launchEnv, DISPLAY: virtualDisplay.display },
      display: virtualDisplay.display,
      displayKind: virtualDisplay.kind || "xvfb",
      interactive: virtualDisplay.interactive === true,
      release: virtualDisplay.release || (async () => {})
    };
  } catch (error) {
    return {
      mode: "headless",
      launchEnv,
      display: "",
      displayKind: "headless",
      interactive: false,
      displayError: error,
      release: async () => {}
    };
  }
}

function isDisplayLaunchError(error) {
  const message = String(error?.message || error || "");
  return /(xserver|x server|missing x server|\$display|ozone_platform_x11|platform failed to initialize|authorization required|unable to open display)/iu.test(message);
}

module.exports = { isDisplayLaunchError, prepareBrowserEnvironment, resolveBrowserMode };
