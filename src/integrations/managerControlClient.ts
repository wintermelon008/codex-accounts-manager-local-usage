import type { ManagerControlJob } from "./managerControlServer";
import { fetchWithTimeout } from "../utils/network";

const CONTROL_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export type ManagerControlClientOptions = {
  getPort: () => number;
  getToken: () => string | undefined;
  requestTimeoutMs?: number;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
};

export type ManagerControlRefreshDispatch = {
  job: ManagerControlJob;
  timedOut: boolean;
};

/**
 * Small Extension Host client for the loopback Manager control API. A missing
 * daemon (or a port that is still starting) is represented by undefined so
 * the caller can retain the existing local scheduler fallback.
 */
export class ManagerControlClient {
  constructor(private readonly options: ManagerControlClientOptions) {}

  async refreshQuotas(accountIds?: readonly string[]): Promise<ManagerControlRefreshDispatch | undefined> {
    const baseUrl = this.getBaseUrl();
    const token = this.options.getToken()?.trim();
    if (!baseUrl || !token) {
      return undefined;
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        baseUrl + "/api/manager/quotas/refresh",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json"
          },
          body: JSON.stringify(accountIds === undefined ? {} : { accountIds: [...accountIds] })
        },
        this.requestTimeoutMs(),
        "Manager quota refresh request"
      );
    } catch {
      return undefined;
    }

    if (!response.ok) {
      return undefined;
    }
    const initialJob = await readJob(response);
    if (!initialJob) {
      return undefined;
    }
    return this.waitForJob(baseUrl, token, initialJob);
  }

  private async waitForJob(
    baseUrl: string,
    token: string,
    initialJob: ManagerControlJob
  ): Promise<ManagerControlRefreshDispatch> {
    let job = initialJob;
    const deadline = Date.now() + this.jobTimeoutMs();
    while (!isTerminal(job) && Date.now() < deadline) {
      await sleep(this.pollIntervalMs());
      if (Date.now() >= deadline) {
        break;
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(
          baseUrl + "/api/manager/jobs/" + encodeURIComponent(job.id),
          { headers: { authorization: "Bearer " + token } },
          this.requestTimeoutMs(),
          "Manager quota refresh status request"
        );
      } catch {
        // The job was already accepted. Do not fall back to a second local
        // refresh while the daemon may still be writing the shared index.
        return { job, timedOut: true };
      }
      if (!response.ok) {
        return { job, timedOut: true };
      }
      const nextJob = await readJob(response);
      if (!nextJob) {
        return { job, timedOut: true };
      }
      job = nextJob;
    }
    return { job, timedOut: !isTerminal(job) };
  }

  private getBaseUrl(): string | undefined {
    const port = this.options.getPort();
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return "http://" + CONTROL_HOST + ":" + port;
  }

  private requestTimeoutMs(): number {
    return normalizePositiveTimeout(this.options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  private jobTimeoutMs(): number {
    return normalizePositiveTimeout(this.options.jobTimeoutMs, DEFAULT_JOB_TIMEOUT_MS);
  }

  private pollIntervalMs(): number {
    return normalizePositiveTimeout(this.options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  }
}

function isTerminal(job: ManagerControlJob): boolean {
  return job.state === "completed" || job.state === "failed";
}

async function readJob(response: Response): Promise<ManagerControlJob | undefined> {
  try {
    const value: unknown = await response.json();
    return isManagerControlJob(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isManagerControlJob(value: unknown): value is ManagerControlJob {
  if (!isRecord(value) || typeof value["id"] !== "string" || value["type"] !== "quota_refresh") {
    return false;
  }
  return (
    value["state"] === "queued" ||
    value["state"] === "running" ||
    value["state"] === "completed" ||
    value["state"] === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
