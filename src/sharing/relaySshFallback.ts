import { request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export type RelaySshFallbackLease = {
  baseUrl: string;
  release(): void;
};

export interface RelaySshFallbackTransport {
  isActive(): boolean;
  recordDirectSuccess(): void;
  recordDirectNetworkFailure(): boolean;
  acquire(): Promise<RelaySshFallbackLease>;
  dispose(): void;
}

export type RelaySshFallbackOptions = {
  sshAlias: string;
  remoteHost?: string;
  remotePort?: number;
  failureThreshold?: number;
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  restartBackoffMs?: number;
};

const SSH_PATH = "/usr/bin/ssh";
const DEFAULT_REMOTE_HOST = "127.0.0.1";
const DEFAULT_REMOTE_PORT = 43118;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_READY_TIMEOUT_MS = 8_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LIFETIME_MS = 180_000;
const DEFAULT_RESTART_BACKOFF_MS = 60_000;

export class RelaySshFallbackTunnel implements RelaySshFallbackTransport {
  private readonly remoteHost: string;
  private readonly remotePort: number;
  private readonly failureThreshold: number;
  private readonly readyTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly restartBackoffMs: number;
  private directFailureStreak = 0;
  private child: ChildProcess | undefined;
  private localPort: number | undefined;
  private starting: Promise<number> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private maxLifetimeTimer: NodeJS.Timeout | undefined;
  private activeLeases = 0;
  private maxLifetimeReached = false;
  private restartBackoffUntil = 0;
  private disposed = false;

  constructor(private readonly options: RelaySshFallbackOptions) {
    this.remoteHost = options.remoteHost ?? DEFAULT_REMOTE_HOST;
    this.remotePort = options.remotePort ?? DEFAULT_REMOTE_PORT;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.readyTimeoutMs = Math.max(1_000, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    this.idleTimeoutMs = Math.max(1_000, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.maxLifetimeMs = Math.max(this.idleTimeoutMs, options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
    this.restartBackoffMs = Math.max(1_000, options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS);
  }

  isActive(): boolean {
    return this.child !== undefined && this.localPort !== undefined;
  }

  recordDirectSuccess(): void {
    this.directFailureStreak = 0;
  }

  recordDirectNetworkFailure(): boolean {
    if (this.disposed) {
      return false;
    }
    this.directFailureStreak += 1;
    return this.directFailureStreak >= this.failureThreshold;
  }

  async acquire(): Promise<RelaySshFallbackLease> {
    if (this.disposed) {
      throw new Error("Relay SSH fallback is disposed");
    }
    const localPort = await this.ensureTunnel();
    this.activeLeases += 1;
    this.clearIdleTimer();
    let released = false;
    return {
      baseUrl: `http://127.0.0.1:${localPort}`,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeLeases = Math.max(0, this.activeLeases - 1);
        this.scheduleCloseIfIdle();
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.clearMaxLifetimeTimer();
    void this.closeTunnel();
  }

  private async ensureTunnel(): Promise<number> {
    if (this.isActive()) {
      return this.localPort!;
    }
    if (this.starting) {
      return this.starting;
    }
    if (Date.now() < this.restartBackoffUntil) {
      throw new Error("Relay SSH fallback is in restart backoff");
    }
    this.starting = this.startTunnel().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startTunnel(): Promise<number> {
    const localPort = await allocateLoopbackPort();
    const child = spawn(
      SSH_PATH,
      [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${localPort}:${this.remoteHost}:${this.remotePort}`,
        this.options.sshAlias
      ],
      { stdio: "ignore" }
    );
    this.child = child;
    this.localPort = localPort;
    this.maxLifetimeReached = false;
    child.once("exit", () => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.localPort = undefined;
      this.clearIdleTimer();
      this.clearMaxLifetimeTimer();
    });

    try {
      await waitForHealth(child, localPort, this.readyTimeoutMs);
      this.maxLifetimeTimer = setTimeout(() => {
        this.maxLifetimeReached = true;
        this.scheduleCloseIfIdle();
      }, this.maxLifetimeMs);
      return localPort;
    } catch (error) {
      this.restartBackoffUntil = Date.now() + this.restartBackoffMs;
      await this.closeTunnel(child);
      throw error;
    }
  }

  private scheduleCloseIfIdle(): void {
    if (this.activeLeases > 0 || !this.isActive()) {
      return;
    }
    if (this.maxLifetimeReached) {
      void this.closeTunnel();
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.closeTunnel();
    }, this.idleTimeoutMs);
  }

  private async closeTunnel(expectedChild?: ChildProcess): Promise<void> {
    const child = this.child;
    if (!child || (expectedChild && child !== expectedChild)) {
      return;
    }
    this.child = undefined;
    this.localPort = undefined;
    this.clearIdleTimer();
    this.clearMaxLifetimeTimer();
    this.maxLifetimeReached = false;
    this.directFailureStreak = 0;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearMaxLifetimeTimer(): void {
    if (this.maxLifetimeTimer) {
      clearTimeout(this.maxLifetimeTimer);
      this.maxLifetimeTimer = undefined;
    }
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a local Relay fallback port");
  }
  return address.port;
}

async function waitForHealth(child: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Relay SSH fallback exited before the port became ready");
    }
    if (await probeHealth(port, Math.min(1_000, Math.max(100, deadline - Date.now())))) {
      return;
    }
    await sleep(200);
  }
  throw new Error("Relay SSH fallback did not become ready");
}

function probeHealth(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs
      },
      (response) => {
        response.resume();
        finish(response.statusCode === 200);
      }
    );
    request.once("error", () => finish(false));
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.end();
  });
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
