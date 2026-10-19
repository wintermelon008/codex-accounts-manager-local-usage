export type NetworkDebugSink = (scope: string, detail: Record<string, unknown>) => void;

let enabled = false;
let enabledReader: (() => boolean) | undefined;
let sink: NetworkDebugSink | undefined;

/** Configure network diagnostics without requiring the VS Code host. */
export function configureNetworkDebug(options: {
  enabled?: boolean;
  enabledReader?: () => boolean;
  sink?: NetworkDebugSink;
}): void {
  enabled = options.enabled ?? false;
  enabledReader = options.enabledReader;
  sink = options.sink;
}

/** Configure diagnostics for a long-running Node host. */
export function configureHeadlessNetworkDebug(enabledValue: boolean): void {
  configureNetworkDebug({
    enabled: enabledValue,
    sink: enabledValue
      ? (scope, detail) => {
          console.info(formatNetworkDebugLines(scope, detail).join("\n"));
        }
      : undefined
  });
}

export function logNetworkEvent(scope: string, detail: Record<string, unknown>): void {
  const active = enabledReader ? enabledReader() : enabled;
  if (!active) {
    return;
  }
  sink?.(scope, detail);
}

export function formatNetworkDebugLines(scope: string, detail: Record<string, unknown>): string[] {
  return [
    `[${new Date().toISOString()}] ${scope}`,
    ...Object.entries(detail).map(([key, value]) => `${key}: ${formatDebugValue(key, value)}`),
    ""
  ];
}

function formatDebugValue(key: string, value: unknown): string {
  if (shouldRedactDebugField(key)) {
    return String(redactDebugScalar(value));
  }

  if (key === "bodyPreview" && typeof value === "string") {
    return sanitizeBodyPreview(value);
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeBodyPreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.stringify(redactDebugValue(JSON.parse(trimmed) as unknown), null, 2);
  } catch {
    return redactDebugText(trimmed);
  }
}

function redactDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDebugValue);
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactDebugText(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      shouldRedactDebugField(key) ? redactDebugScalar(entry) : redactDebugValue(entry)
    ])
  );
}

function shouldRedactDebugField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized === "email" ||
    normalized.endsWith("email") ||
    normalized === "userid" ||
    normalized === "accountuserid" ||
    normalized === "accountid" ||
    normalized === "organizationid" ||
    normalized === "workspaceid"
  );
}

function redactDebugScalar(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.includes("@")) {
      return "[redacted-email]";
    }
    return value.trim() ? "[redacted]" : value;
  }
  if (value == null) {
    return value;
  }
  return "[redacted]";
}

function redactDebugText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/"(?:access|refresh|id|session|auth)[-_ ]?token"\s*:\s*"[^"]*"/gi, '"token":"[redacted]"')
    .replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"[redacted]"')
    .replace(/\b(?:org|account|workspace|user)[-_ ]?id\b["':= ]+[\w-]+/gi, "[redacted-id]")
    .trim();
}
