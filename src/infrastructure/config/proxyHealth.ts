import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";
import { getConfiguredProxySettings } from "./proxyEnvironment";

export const PROXY_HEALTH_CHECK_URL = "https://api.openai.com/v1/models";
const DEFAULT_PROXY_HEALTH_TIMEOUT_MS = 5_000;

export type ProxyProbeResult = {
  address: string;
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  reason?: "timeout" | "connection" | "http";
};

export type ProxyProbeSummary = {
  selectedAddress: string;
  results: ProxyProbeResult[];
  selectedResult: ProxyProbeResult;
  fallbackAddress?: string;
};

/**
 * Probe one proxy without touching the process-wide Manager dispatcher.
 * A 2xx-4xx response (except proxy authentication failure) proves that the
 * request reached the OpenAI endpoint, even when the endpoint rejects the
 * request for auth or rate-limit reasons.
 */
export async function probeProxyAddress(
  address: string,
  timeoutMs = DEFAULT_PROXY_HEALTH_TIMEOUT_MS
): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher: EnvHttpProxyAgent | undefined;

  try {
    const settings = await getConfiguredProxySettings(address || undefined);
    dispatcher = new EnvHttpProxyAgent(settings);
    const response = await undiciFetch(PROXY_HEALTH_CHECK_URL, {
      method: "GET",
      dispatcher,
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    await response.body?.cancel();

    const proxyRejected = response.status === 407;
    return {
      address,
      ok: response.status >= 200 && response.status < 500 && !proxyRejected,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      reason: proxyRejected || response.status >= 500 ? "http" : undefined
    };
  } catch (error) {
    return {
      address,
      ok: false,
      latencyMs: Date.now() - startedAt,
      reason: isAbortError(error) ? "timeout" : "connection"
    };
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close().catch(() => undefined);
  }
}

/**
 * Test every configured candidate, with the currently selected address first,
 * and identify the first healthy fallback when the selected address fails.
 * The probe is injectable so ordering/fallback behavior can be tested without
 * making real network requests.
 */
export async function testProxyCandidates(
  addresses: readonly string[],
  selectedAddress: string,
  probe: (address: string) => Promise<ProxyProbeResult> = probeProxyAddress
): Promise<ProxyProbeSummary> {
  const normalizedSelectedAddress = selectedAddress.trim();
  const candidates = uniqueAddresses([normalizedSelectedAddress, ...addresses]);
  const results: ProxyProbeResult[] = [];

  for (const address of candidates) {
    results.push(await probe(address));
  }

  const selectedResult = results.find((result) => result.address === normalizedSelectedAddress) ?? results[0]!;
  const fallbackAddress = selectedResult.ok
    ? undefined
    : results.find((result) => result.ok && result.address !== normalizedSelectedAddress)?.address;

  return {
    selectedAddress: normalizedSelectedAddress,
    results,
    selectedResult,
    fallbackAddress
  };
}

function uniqueAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const normalized = address.trim();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
