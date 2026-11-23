import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../src/core/errors";
import { AccountSharingService } from "../src/sharing/accountSharingService";
import type { RelaySshFallbackLease, RelaySshFallbackTransport } from "../src/sharing/relaySshFallback";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/utils/network", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/network")>("../src/utils/network");
  return {
    ...actual,
    fetchWithTimeout: fetchWithTimeoutMock,
    retryWithBackoff: async <T>(operation: () => Promise<T>) => operation()
  };
});

const directories: string[] = [];

afterEach(async () => {
  fetchWithTimeoutMock.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createContext(directory: string) {
  return {
    globalStorageUri: { fsPath: directory },
    globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
    secrets: { delete: vi.fn(async () => undefined) }
  };
}

function createFallback(): RelaySshFallbackTransport & {
  directFailures: number;
  acquireCalls: number;
  releases: number;
} {
  let active = false;
  let directFailures = 0;
  let acquireCalls = 0;
  let releases = 0;
  return {
    get directFailures() {
      return directFailures;
    },
    get acquireCalls() {
      return acquireCalls;
    },
    get releases() {
      return releases;
    },
    isActive: () => active,
    recordDirectSuccess: vi.fn(() => {
      directFailures = 0;
    }),
    recordDirectNetworkFailure: vi.fn(() => {
      directFailures += 1;
      if (directFailures >= 5) {
        active = true;
        return true;
      }
      return false;
    }),
    acquire: vi.fn(async (): Promise<RelaySshFallbackLease> => {
      acquireCalls += 1;
      active = true;
      return {
        baseUrl: "http://127.0.0.1:43121",
        release: () => {
          releases += 1;
        }
      };
    }),
    dispose: vi.fn()
  };
}

async function createService(fallback: RelaySshFallbackTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-relay-fallback-"));
  directories.push(directory);
  const service = new AccountSharingService(
    createContext(directory) as never,
    { listAccounts: vi.fn(async () => []), onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })) } as never,
    vi.fn(),
    {
      relayUrl: () => "http://100.114.125.9:43120",
      relaySshFallback: fallback
    }
  );
  await service.initialize();
  const internals = service as unknown as {
    relayToken: string;
    relayRegistrationValidatedAt: number;
    request<T>(path: string, init?: RequestInit): Promise<T>;
  };
  internals.relayToken = "relay-token";
  internals.relayRegistrationValidatedAt = Date.now();
  return { service, request: internals.request.bind(service) };
}

describe("Relay SSH fallback transport", () => {
  it("opens one fallback tunnel after five logical direct failures and retries a GET", async () => {
    const fallback = createFallback();
    const { service, request } = await createService(fallback);
    let directCalls = 0;
    let fallbackCalls = 0;
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:43121")) {
        fallbackCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      directCalls += 1;
      throw new NetworkError("Sharing Relay request timed out after 10s");
    });

    for (let index = 0; index < 4; index += 1) {
      await expect(request("/v1/sharing/credential-syncs/inbox")).rejects.toThrow("timed out");
    }
    await expect(request("/v1/sharing/credential-syncs/inbox")).resolves.toEqual({ ok: true });

    expect(directCalls).toBe(5);
    expect(fallbackCalls).toBe(1);
    expect(fallback.acquireCalls).toBe(1);
    expect(fallback.releases).toBe(1);
    service.dispose();
  });

  it("does not replay an uncertain write, but routes the next operation through fallback", async () => {
    const fallback = createFallback();
    const { service, request } = await createService(fallback);
    let directCalls = 0;
    let fallbackCalls = 0;
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:43121")) {
        fallbackCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      directCalls += 1;
      throw new NetworkError("Sharing Relay request timed out after 10s");
    });

    for (let index = 0; index < 4; index += 1) {
      await expect(request("/v1/sharing/credential-syncs/inbox")).rejects.toThrow("timed out");
    }
    await expect(
      request("/v1/sharing/credential-syncs/sync/snapshot", {
        method: "PUT",
        body: JSON.stringify({ version: 49 })
      })
    ).rejects.toThrow("timed out");
    await expect(request("/v1/sharing/credential-syncs/sent")).resolves.toEqual({ ok: true });

    expect(directCalls).toBe(5);
    expect(fallbackCalls).toBe(1);
    service.dispose();
  });
});
