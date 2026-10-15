import { NetworkError, ErrorCode } from "../core/errors";
import { fetch as undiciFetch } from "undici";
import { getCodexProxyDispatcher } from "../infrastructure/config/proxyEnvironment";

const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_DELAYS_MS = [300, 800, 1500] as const;

export interface RetryWithBackoffOptions<T> {
  delaysMs?: readonly number[];
  shouldRetryError?: (error: unknown) => boolean;
  shouldRetryResult?: (result: T) => boolean;
}

export async function fetchWithTimeout(
  input: string | URL | globalThis.Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  timeoutLabel = "Request"
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal =
    init.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  callerSignal?.throwIfAborted();
  const cancel = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  let phase = "headers";
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchWithConfiguredProxy(input, {
      ...init,
      signal: controller.signal
    });
    // Manager endpoints return finite JSON, text, or SSE bodies. Buffer the
    // body here so the deadline also covers a response that stalls after its
    // headers arrive; callers still receive a normal, single-use Response.
    phase = "body";
    const body = response.body ? await response.arrayBuffer() : null;
    const buffered = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    Object.defineProperties(buffered, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type }
    });
    return buffered;
  } catch (error) {
    if (timedOut) {
      throw new NetworkError(`${timeoutLabel} timed out after ${Math.round(timeoutMs / 1000)}s`, {
        code: ErrorCode.NETWORK_ERROR,
        cause: error,
        context: { timeoutMs, timeoutLabel, phase }
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

/**
 * Sends a request through the same request-local proxy dispatcher used by
 * Manager. Integrations use this instead of relying on Node's global fetch to
 * discover process proxy variables on its own.
 */
export async function fetchWithConfiguredProxy(
  input: string | URL | globalThis.Request,
  init: RequestInit = {}
): Promise<Response> {
  const dispatcher = getCodexProxyDispatcher();
  if (dispatcher) {
    return (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  }
  return fetch(input, init);
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryWithBackoffOptions<T> = {}
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const result = await operation();
      if (attempt < delays.length && options.shouldRetryResult?.(result)) {
        await sleep(delays[attempt]!);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length || !options.shouldRetryError?.(error)) {
        throw error;
      }
      await sleep(delays[attempt]!);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry operation failed");
}

export function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isRetriableNetworkError(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    error.name === "TypeError" ||
    normalized.includes("network") ||
    normalized.includes("fetch failed") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket") ||
    normalized.includes("enotfound") ||
    normalized.includes("temporarily unavailable")
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
