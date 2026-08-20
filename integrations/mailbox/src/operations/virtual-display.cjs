"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_DISPLAY_START = 99;
const DEFAULT_DISPLAY_END = 119;
const DEFAULT_STARTUP_TIMEOUT_MS = 4_000;
const activeDisplays = new Map();

function normalizeDisplayNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function displaySocketPath(displayNumber, fsImpl = fs) {
  const number = normalizeDisplayNumber(displayNumber);
  if (number === null) return "";
  const socketDirectory = process.env.X11_SOCKET_DIR || "/tmp/.X11-unix";
  return path.join(socketDirectory, `X${number}`);
}

function displayIsOccupied(displayNumber, fsImpl = fs) {
  const display = `:${displayNumber}`;
  return activeDisplays.has(display) || Boolean(displaySocketPath(displayNumber, fsImpl) && fsImpl.existsSync(displaySocketPath(displayNumber, fsImpl)));
}

function createLaunchError(display, detail) {
  const suffix = detail ? `：${String(detail).replace(/[\r\n]+/gu, " ").slice(0, 240)}` : "";
  return new Error(`Xvfb 无法启动虚拟显示 ${display}${suffix}`);
}

function waitForDisplay(child, displayNumber, {
  fsImpl = fs,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  stderr = "",
  stderrProvider
} = {}) {
  const socket = displaySocketPath(displayNumber, fsImpl);
  const getStderr = typeof stderrProvider === "function" ? stderrProvider : () => stderr;
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    const timer = setTimeout(() => {
      const detail = getStderr();
      finishReject(createLaunchError(`:${displayNumber}`, `启动超时${detail ? `，${detail}` : ""}`));
    }, timeoutMs);

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      resolve();
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      reject(error);
    };
    const check = () => {
      if (socket && fsImpl.existsSync(socket)) {
        finishResolve();
        return;
      }
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        const detail = getStderr();
        finishReject(createLaunchError(`:${displayNumber}`, `进程已退出 code=${child.exitCode}${detail ? `，${detail}` : ""}`));
        return;
      }
      pollTimer = setTimeout(check, 50);
    };

    child?.once?.("error", (error) => finishReject(createLaunchError(`:${displayNumber}`, error?.code || error?.message)));
    child?.once?.("exit", (code, signal) => {
      if (!settled) {
        const detail = getStderr();
        finishReject(createLaunchError(`:${displayNumber}`, `进程已退出 code=${code ?? "?"} signal=${signal || "?"}${detail ? `，${detail}` : ""}`));
      }
    });
    check();
  });
}

function stopDisplayProcess(child) {
  try {
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  } catch {
    // The browser flow must not fail while cleaning up a virtual display.
  }
}

async function startDisplay(displayNumber, {
  command = "Xvfb",
  width = 1440,
  height = 900,
  depth = 24,
  env = process.env,
  fsImpl = fs,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
} = {}) {
  const display = `:${displayNumber}`;
  if (displayIsOccupied(displayNumber, fsImpl)) {
    throw new Error(`虚拟显示 ${display} 已被占用`);
  }

  const reservation = { child: null };
  activeDisplays.set(display, reservation);
  let stderr = "";
  try {
    const child = spawnImpl(command, [
      display,
      "-screen",
      "0",
      `${width}x${height}x${depth}`,
      "-nolisten",
      "tcp"
    ], {
      env: { ...env },
      stdio: ["ignore", "ignore", "pipe"]
    });
    reservation.child = child;
    child?.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.replace(/[\r\n]+/gu, " ").slice(-240);
    });
    await waitForDisplay(child, displayNumber, { fsImpl, timeoutMs, stderrProvider: () => stderr });

    let released = false;
    return {
      display,
      kind: "xvfb",
      interactive: false,
      async release() {
        if (released) return;
        released = true;
        activeDisplays.delete(display);
        stopDisplayProcess(child);
      }
    };
  } catch (error) {
    activeDisplays.delete(display);
    stopDisplayProcess(reservation.child);
    throw error;
  }
}

async function ensureVirtualDisplay({
  displayStart = DEFAULT_DISPLAY_START,
  displayEnd = DEFAULT_DISPLAY_END,
  ...options
} = {}) {
  const start = normalizeDisplayNumber(displayStart);
  const end = normalizeDisplayNumber(displayEnd);
  if (start === null || end === null || end < start) {
    throw new Error("Xvfb 显示编号范围无效");
  }

  let lastError;
  for (let displayNumber = start; displayNumber <= end; displayNumber += 1) {
    if (displayIsOccupied(displayNumber, options.fsImpl || fs)) continue;
    try {
      return await startDisplay(displayNumber, options);
    } catch (error) {
      lastError = error;
      if (!/已被占用/u.test(String(error?.message || error))) throw error;
    }
  }
  throw lastError || new Error(`没有可用的 Xvfb 显示（:${start}-:${end}）`);
}

module.exports = {
  DEFAULT_DISPLAY_END,
  DEFAULT_DISPLAY_START,
  displaySocketPath,
  ensureVirtualDisplay,
  normalizeDisplayNumber
};
