import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import { CodexTokens } from "../core/types";
import { isTokenExpired } from "../utils/jwt";
import { fetchWithTimeout } from "../utils/network";
import { logNetworkEvent } from "../utils/debug";
import { AuthError, ErrorCode, APIError, formatApiErrorMessage } from "../core/errors";
import {
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPES,
  OAUTH_ORIGINATOR,
  OAUTH_CALLBACK_PORT
} from "../infrastructure/config/apiEndpoints";

// 使用别名保持向后兼容
const CLIENT_ID = OAUTH_CLIENT_ID;
const SCOPES = OAUTH_SCOPES;
const ORIGINATOR = OAUTH_ORIGINATOR;
const CALLBACK_PORT = OAUTH_CALLBACK_PORT;

/**
 * Token 刷新提前量（秒）。对齐 cockpit-tools 的 TOKEN_REFRESH_SKEW_SECONDS，
 * 在 access_token 或 id_token 剩余有效期不足 5 分钟时即触发刷新，避免边界过期。
 */
export const TOKEN_REFRESH_SKEW_SECONDS = 300;

interface OAuthSession {
  state: string;
  verifier: string;
  server: http.Server;
  redirectUri: string;
}

interface OAuthCodeWaiter {
  /** Resolves only after the local callback server has successfully bound its port. */
  ready: Promise<void>;
  promise: Promise<string>;
  dispose: () => void;
}

export interface PreparedOAuthLoginSession {
  state: string;
  verifier: string;
  redirectUri: string;
  authUrl: string;
}

export async function loginWithOAuth(cancellationToken?: vscode.CancellationToken): Promise<CodexTokens> {
  const prepared = prepareOAuthLoginSession();
  return runPreparedOAuthLoginSession(prepared, cancellationToken);
}

export async function refreshTokens(refreshToken: string, currentIdToken?: string): Promise<CodexTokens> {
  const response = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID
      })
    },
    25000,
    "Token refresh"
  );

  const raw = await response.text();
  logNetworkEvent("oauth.refresh", {
    ok: response.ok,
    status: response.status,
    hasRefreshToken: Boolean(refreshToken),
    bodyPreview: raw
  });
  if (!response.ok) {
    const errorCode = extractTokenErrorCode(raw);
    throw new APIError(formatApiErrorMessage("Token refresh failed", response.status, raw), {
      statusCode: response.status,
      responseBody: raw,
      context: errorCode ? { errorCode } : undefined
    });
  }

  const payload = JSON.parse(raw) as Record<string, unknown>;
  // OpenAI refresh 端点偶尔不返回新的 id_token，此时复用本地旧值（对齐 cockpit refresh_access_token_with_fallback）。
  const idToken = readOptionalString(payload, "id_token") ?? (currentIdToken?.trim() ? currentIdToken : undefined);
  if (!idToken) {
    throw new AuthError("Missing id_token in OAuth refresh response and no local fallback available", {
      code: ErrorCode.AUTH_TOKEN_MISSING,
      context: { key: "id_token" }
    });
  }

  return {
    idToken,
    accessToken: readString(payload, "access_token"),
    refreshToken: readOptionalString(payload, "refresh_token") ?? refreshToken
  };
}

/**
 * 从 token 端点错误响应中提取 error code，便于诊断（对齐 cockpit extract_token_error_code）。
 */
function extractTokenErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const fromError = value["error"];
    if (typeof fromError === "string" && fromError) {
      return fromError;
    }
    if (fromError && typeof fromError === "object") {
      const code = (fromError as Record<string, unknown>)["code"];
      if (typeof code === "string" && code) {
        return code;
      }
    }
    const code = value["code"];
    return typeof code === "string" && code ? code : undefined;
  } catch {
    return undefined;
  }
}

export function needsRefresh(accessToken: string, skewSeconds = TOKEN_REFRESH_SKEW_SECONDS): boolean {
  return isTokenExpired(accessToken, skewSeconds);
}

export function needsTokenRefresh(
  tokens: Pick<CodexTokens, "idToken" | "accessToken">,
  skewSeconds = TOKEN_REFRESH_SKEW_SECONDS
): boolean {
  return isTokenExpired(tokens.accessToken, skewSeconds) || isTokenExpired(tokens.idToken, skewSeconds);
}

export function prepareOAuthLoginSession(port = CALLBACK_PORT): PreparedOAuthLoginSession {
  const verifier = randomBase64Url();
  const state = randomBase64Url();
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authUrl = buildOAuthAuthorizationUrl(state, verifier, redirectUri);

  return {
    state,
    verifier,
    redirectUri,
    authUrl
  };
}

export async function completeOAuthLoginSession(
  session: Pick<PreparedOAuthLoginSession, "state" | "verifier" | "redirectUri">,
  callbackUrl: string
): Promise<CodexTokens> {
  const code = extractCodeFromCallbackUrl(callbackUrl, session.redirectUri, session.state);
  return exchangeCodeForTokens(code, session.verifier, session.redirectUri);
}

export async function runPreparedOAuthLoginSession(
  session: PreparedOAuthLoginSession,
  cancellationToken?: vscode.CancellationToken
): Promise<CodexTokens> {
  const runtimeSession: OAuthSession = {
    state: session.state,
    verifier: session.verifier,
    server: http.createServer(),
    redirectUri: session.redirectUri
  };
  const codeWaiter = createCodeWaiter(runtimeSession, cancellationToken);

  try {
    // Do not open the browser until the callback listener is actually ready.
    // Otherwise an EADDRINUSE error can arrive after the login page was opened,
    // leaving the user with a misleading manual-callback message.
    await codeWaiter.ready;

    if (cancellationToken?.isCancellationRequested) {
      throw new AuthError("OAuth login cancelled by user.", {
        code: ErrorCode.AUTH_OAUTH_FAILED
      });
    }

    await ensureOAuthCallbackTunnel(session.redirectUri);

    const opened = await vscode.env.openExternal(vscode.Uri.parse(session.authUrl));
    if (!opened) {
      void vscode.env.clipboard.writeText(session.authUrl);
      throw new AuthError(
        "Unable to open the browser automatically. The authorization URL was copied to your clipboard.",
        {
          code: ErrorCode.AUTH_OAUTH_FAILED
        }
      );
    }

    if (cancellationToken?.isCancellationRequested) {
      throw new AuthError("OAuth login cancelled by user.", {
        code: ErrorCode.AUTH_OAUTH_FAILED
      });
    }

    const code = await codeWaiter.promise;
    return exchangeCodeForTokens(code, session.verifier, session.redirectUri);
  } finally {
    codeWaiter.dispose();
  }
}

export function extractCodeFromCallbackUrl(callbackUrl: string, redirectUri: string, expectedState: string): string {
  const validationError = validateManualCallback(callbackUrl, redirectUri, expectedState);
  if (validationError) {
    throw new AuthError(validationError, {
      code: ErrorCode.AUTH_TOKEN_INVALID
    });
  }

  const url = new URL(callbackUrl.trim());
  const code = url.searchParams.get("code");
  if (!code) {
    throw new AuthError("Callback URL does not include code", {
      code: ErrorCode.AUTH_TOKEN_INVALID
    });
  }

  return code;
}

function createCodeWaiter(session: OAuthSession, cancellationToken?: vscode.CancellationToken): OAuthCodeWaiter {
  let settled = false;
  let readySettled = false;
  let closeWhenListening = false;
  let timeout: NodeJS.Timeout | undefined;
  let cancelDisposable: vscode.Disposable | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (reason?: unknown) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const finishReady = (error?: unknown): void => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (error) {
      rejectReady(error);
    } else {
      resolveReady();
    }
  };

  const finish = (callback?: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    cancelDisposable?.dispose();
    if (session.server.listening) {
      session.server.close();
    } else {
      // Cancellation can race the asynchronous listen() call. Close as soon
      // as Node reports a late successful bind so no listener is leaked.
      closeWhenListening = true;
    }
    callback?.();
  };

  const createAuthError = (message: string): AuthError => new AuthError(message, { code: ErrorCode.AUTH_OAUTH_FAILED });

  const promise = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(() => {
      const error = createAuthError("OAuth login was not completed in the browser.");
      finishReady(error);
      finish(() => {
        reject(error);
      });
    }, 300_000);

    cancelDisposable = cancellationToken?.onCancellationRequested(() => {
      const error = createAuthError("OAuth login cancelled by user.");
      finishReady(error);
      finish(() => {
        reject(error);
      });
    });

    session.server.on("request", (req, res) => {
      if (!req.url) {
        return;
      }

      const url = new URL(req.url, session.redirectUri);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== session.state) {
        res.writeHead(400);
        res.end("State mismatch");
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end("Missing code");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(successHtml());
      logNetworkEvent("oauth.callback", {
        ok: true,
        path: url.pathname,
        hasCode: true
      });
      finish(() => {
        resolve(code);
      });
    });

    const handleListenError = (error: unknown): void => {
      const isAddrInUse =
        error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      const authError = createAuthError(
        isAddrInUse
          ? `Automatic OAuth callback listener is unavailable on ${session.redirectUri}. Use the Add Account dialog to complete the callback manually.`
          : `Unable to bind OAuth callback port: ${String(error)}`
      );
      finishReady(authError);
      finish(() => {
        reject(authError);
      });
    };

    session.server.once("error", handleListenError);

    session.server.once("listening", () => {
      const address = session.server.address();
      if (!address || typeof address === "string") {
        const authError = createAuthError("Unable to determine OAuth callback port after binding.");
        finishReady(authError);
        finish(() => {
          reject(authError);
        });
        return;
      }

      finishReady();
      if (closeWhenListening || settled) {
        session.server.close();
      }
    });

    try {
      session.server.listen(Number(new URL(session.redirectUri).port), "127.0.0.1");
    } catch (error) {
      handleListenError(error);
    }
  });

  // A bind failure rejects `ready` before the caller can await the callback
  // promise. Mark that secondary rejection as handled while still returning
  // the original promise to the normal callback path.
  void promise.catch(() => undefined);

  return {
    ready,
    promise,
    dispose: () => {
      finish();
    }
  };
}

function buildOAuthAuthorizationUrl(state: string, verifier: string, redirectUri: string): string {
  const challenge = sha256Base64Url(verifier);
  return (
    `${AUTH_ENDPOINT}?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
    // Keep the loopback URI visible in the query. VS Code's Remote-SSH
    // external opener detects this form and forwards the embedded callback
    // port before opening the browser. The decoded value remains the exact
    // registered OAuth redirect URI.
    `&redirect_uri=${redirectUri}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256&id_token_add_organizations=true` +
    `&codex_cli_simplified_flow=true&state=${encodeURIComponent(state)}` +
    `&originator=${encodeURIComponent(ORIGINATOR)}`
  );
}

async function ensureOAuthCallbackTunnel(redirectUri: string): Promise<void> {
  let externalUri: vscode.Uri;
  try {
    externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(redirectUri));
  } catch (error) {
    throw new AuthError(`VS Code cannot forward the OAuth callback port on ${redirectUri}: ${String(error)}`, {
      code: ErrorCode.AUTH_OAUTH_FAILED
    });
  }

  const external = new URL(externalUri.toString(true));
  const target = new URL(redirectUri);
  const targetPort = Number(target.port);
  const externalPort = Number(external.port || (external.protocol === "https:" ? 443 : 80));
  logNetworkEvent("oauth.callback.tunnel", {
    remotePort: targetPort,
    localPort: externalPort,
    localHost: external.hostname,
    samePort: externalPort === targetPort
  });

  // OpenAI validates the registered redirect_uri in the authorization request,
  // while VS Code may expose the remote listener on another local port (for
  // example localhost:1457). Calling asExternalUri establishes that tunnel;
  // the callback server and token exchange must continue using redirectUri.
}

async function exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<CodexTokens> {
  const response = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier
      }).toString()
    },
    15000,
    "OAuth token exchange"
  );

  const raw = await response.text();
  logNetworkEvent("oauth.exchange", {
    ok: response.ok,
    status: response.status,
    redirectUri,
    bodyPreview: raw
  });
  if (!response.ok) {
    const errorCode = extractTokenErrorCode(raw);
    throw new APIError(formatApiErrorMessage("Token exchange failed", response.status, raw), {
      statusCode: response.status,
      responseBody: raw,
      context: errorCode ? { errorCode } : undefined
    });
  }

  const payload = JSON.parse(raw) as Record<string, unknown>;
  return {
    idToken: readString(payload, "id_token"),
    accessToken: readString(payload, "access_token"),
    refreshToken: readOptionalString(payload, "refresh_token")
  };
}

function randomBase64Url(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function validateManualCallback(value: string, redirectUri: string, expectedState: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const expected = new URL(redirectUri);
    if (url.protocol !== expected.protocol || url.pathname !== expected.pathname || !isLoopbackHost(url.hostname)) {
      return `Expected a loopback callback URL for ${expected.pathname}`;
    }
    if (url.searchParams.get("state") !== expectedState) {
      return "State mismatch in callback URL";
    }
    if (!url.searchParams.get("code")) {
      return "Callback URL does not include code";
    }
    return undefined;
  } catch {
    return "Paste the full callback URL from the browser address bar";
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new AuthError(`Missing ${key} in OAuth response`, {
      code: ErrorCode.AUTH_TOKEN_MISSING,
      context: { key }
    });
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Codex Authorized</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, #f4d35e, #ee964b 40%, #0d3b66 100%); font-family: Georgia, serif; color: #fff7e6; }
    .card { padding: 32px 40px; border: 1px solid rgba(255,255,255,.2); border-radius: 20px; background: rgba(9,25,40,.45); backdrop-filter: blur(10px); text-align: center; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 0; font-size: 16px; opacity: .92; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization complete</h1>
    <p>You can close this tab and return to VS Code.</p>
  </div>
</body>
</html>`;
}
