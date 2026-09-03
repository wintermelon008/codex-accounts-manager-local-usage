#!/usr/bin/env node

const command = process.argv[2] ?? "list";
const options = parseOptions(process.argv.slice(3));
const baseUrl = (process.env.CODEX_SESSION_HUB_URL ?? `http://127.0.0.1:${process.env.CODEX_ACCOUNTS_MANAGER_CONTROL_PORT ?? "43117"}`).replace(/\/$/u, "");
const token = process.env.CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN?.trim();

if (!token) {
  fail("CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN is required");
} else {
  try {
    if (command === "list") {
      await request("/api/manager/sessions", { search: listSearch(options) });
    } else if (command === "show") {
      await request(`/api/manager/sessions/${encodeURIComponent(required(options, "conversation"))}`);
    } else if (command === "locate") {
      await request(`/api/manager/sessions/locate`, { search: { value: required(options, "value") } });
    } else if (command === "register") {
      await request("/api/manager/sessions", { method: "POST", body: registrationBody(options) });
    } else {
      fail("usage: session-hub.mjs list|show|locate|register [options]");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function request(path, options = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.search ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

function listSearch(options) {
  return {
    project: options.project,
    goalId: options.goal,
    runId: options.run,
    kind: options.kind,
    status: options.status,
    query: options.query
  };
}

function registrationBody(options) {
  const body = {
    conversationId: options.conversation,
    kind: options.kind,
    project: options.project,
    goalId: options.goal,
    runId: options.run,
    nativeThreadId: options.thread,
    title: options.title,
    status: options.status,
    artifactLocator: options.artifact,
    externalRefs: options.ref ? [options.ref] : undefined
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function parseOptions(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const key = value.slice(2).replaceAll("-", "_");
    const next = values[index + 1];
    if (next?.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(options, name) {
  const value = options[name];
  if (!value?.trim()) {
    throw new Error(`--${name.replaceAll("_", "-")} is required`);
  }
  return value.trim();
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}
