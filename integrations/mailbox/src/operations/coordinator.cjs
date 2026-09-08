"use strict";

const { assertMailboxProvider } = require("../core/provider.cjs");

const DEFAULT_MAX_CONCURRENT_OPERATIONS = 10;

class MailboxOperationCoordinator {
  constructor({
    pool,
    provider,
    providers,
    maxConcurrent = DEFAULT_MAX_CONCURRENT_OPERATIONS,
    now = () => Date.now(),
    sleep = delay,
    onOperationChange = () => {}
  }) {
    if (!pool || typeof pool.listAccounts !== "function") {
      throw new TypeError("Mailbox operation coordinator requires a mailbox pool");
    }
    this.pool = pool;
    this.providers = providers ?? createProviderSource(provider);
    this.maxConcurrent = normalizePositive(maxConcurrent, DEFAULT_MAX_CONCURRENT_OPERATIONS);
    this.now = now;
    this.sleep = sleep;
    this.onOperationChange = typeof onOperationChange === "function" ? onOperationChange : () => {};
    this.operations = new Map();
    this.nextOperationId = 1;
  }

  isActive(mailboxId) {
    return mailboxId ? this.operations.has(mailboxId) : this.operations.size > 0;
  }

  getActiveOperations() {
    return [...this.operations.values()].map((operation) => ({
      mailboxId: operation.mailboxId,
      kind: operation.kind,
      id: operation.id,
      batchId: operation.batchId,
      progress: {
        completed: operation.batch.completed,
        total: operation.batch.total
      }
    }));
  }

  async queryOnce(ids, options = {}) {
    return this.run("query", ids, async (account, provider, signal) => {
      const result = await provider.query(account, { ...options, signal });
      throwIfAborted(signal);
      await this.pool.recordQueryResult(account.id, result, { historyMode: provider.capabilities?.history });
      return withMailboxId(account, result);
    });
  }

  async waitForCodes(ids, { timeoutMs = 120_000, pollMs = 5_000, maxMessages } = {}) {
    const timeout = normalizePositive(timeoutMs, 120_000);
    const interval = normalizePositive(pollMs, 5_000);
    return this.run("wait", ids, async (account, provider, signal) => {
      const startedAt = this.now();
      const queryOptions = { maxMessages: maxMessages ?? provider.capabilities?.maxMessages, signal };
      const first = await provider.query(account, queryOptions);
      throwIfAborted(signal);
      await this.pool.recordQueryResult(account.id, first, { historyMode: provider.capabilities?.history });
      if (!first.ok) {
        return withMailboxId(account, { ...first, operation: "wait" });
      }

      const seen = new Set((first.messages ?? []).map((message) => message.fingerprint ?? message.id));
      const deadline = startedAt + timeout;
      while (this.now() < deadline) {
        await this.sleep(Math.min(interval, Math.max(1, deadline - this.now())), signal);
        const next = await provider.query(account, queryOptions);
        throwIfAborted(signal);
        await this.pool.recordQueryResult(account.id, next, { historyMode: provider.capabilities?.history });
        if (!next.ok) {
          return withMailboxId(account, { ...next, operation: "wait" });
        }
        const messages = findNewCodeMessages(next.messages, seen, startedAt);
        for (const message of next.messages ?? []) {
          seen.add(message.fingerprint ?? message.id);
        }
        if (messages.length > 0) {
          return withMailboxId(account, {
            ...next,
            operation: "wait",
            status: "code_found",
            messages,
            codes: uniqueCodes(messages)
          });
        }
      }

      return withMailboxId(account, {
        ok: true,
        providerId: provider.id,
        operation: "wait",
        status: "timeout",
        address: account.address,
        messages: [],
        codes: [],
        fetchedAt: new Date().toISOString()
      });
    });
  }

  async renew(ids, options = {}) {
    return this.run("renewal", ids, async (account, provider, signal) => {
      if (typeof provider.renew !== "function") {
        const result = {
          ok: false,
          providerId: provider.id,
          operation: "renewal",
          address: account.address,
          messages: [],
          codes: [],
          error: {
            stage: "capability",
            code: "renewal_not_supported",
            message: "This mailbox provider does not support manual renewal",
            retryable: false
          }
        };
        await this.pool.recordRenewalResult(account.id, result);
        return withMailboxId(account, result);
      }
      const result = await provider.renew(account, { ...options, signal });
      throwIfAborted(signal);
      await this.pool.recordRenewalResult(account.id, result);
      return withMailboxId(account, sanitizePublicRenewalResult(result));
    });
  }

  stop(mailboxId) {
    const targets = mailboxId ? [this.operations.get(mailboxId)] : [...this.operations.values()];
    let stopped = false;
    let changed = false;
    for (const operation of targets) {
      if (!operation) {
        continue;
      }
      operation.stopped = true;
      operation.controller.abort();
      if (this.operations.get(operation.mailboxId) === operation) {
        this.operations.delete(operation.mailboxId);
        changed = true;
      }
      stopped = true;
    }
    if (changed) {
      this.notifyOperationChange();
    }
    return stopped;
  }

  async run(operation, ids, worker) {
    const accounts = await this.pool.listAccounts({ includeDisabled: false });
    const selected = selectAccounts(accounts, ids);
    if (selected.length === 0) {
      return { operation, results: [], stopped: false };
    }

    const busy = selected.find((account) => this.operations.has(account.id));
    if (busy) {
      throw new Error(`Mailbox operation is already running for ${busy.address}`);
    }

    const entries = new Map();
    const batch = {
      id: this.nextOperationId++,
      kind: operation,
      completed: 0,
      total: selected.length
    };
    for (const account of selected) {
      const active = {
        id: this.nextOperationId++,
        mailboxId: account.id,
        kind: operation,
        batchId: batch.id,
        batch,
        controller: new AbortController(),
        stopped: false,
        started: false
      };
      entries.set(account.id, active);
      this.operations.set(account.id, active);
    }
    this.notifyOperationChange();

    try {
      const results = await runWithConcurrency(selected, this.maxConcurrent, async (account) => {
        const active = entries.get(account.id);
        if (!active || active.stopped) {
          if (active) {
            this.completeOperation(active);
          }
          return withMailboxId(account, abortedResult(operation));
        }
        active.started = true;
        return this.runOne(operation, account, worker, active);
      });
      return {
        operation,
        results,
        stopped: results.some((result) => result.error?.code === "request_aborted")
      };
    } finally {
      let changed = false;
      for (const [accountId, active] of entries) {
        if (this.operations.get(accountId) !== active) {
          continue;
        }
        this.operations.delete(accountId);
        changed = true;
      }
      if (changed) {
        this.notifyOperationChange();
      }
    }
  }

  async runOne(operation, account, worker, active) {
    const provider = this.providers.get(account.providerId);
    try {
      if (!provider) {
        throw new Error(`Mailbox provider '${account.providerId}' is unavailable`);
      }
      return await worker(account, assertOperationProvider(provider), active.controller.signal);
    } catch (error) {
      const failure = {
        ok: false,
        providerId: account.providerId,
        operation,
        address: account.address,
        messages: [],
        codes: [],
        error: normalizeOperationError(error)
      };
      if (active.stopped) {
        return withMailboxId(account, failure);
      }
      try {
        if (operation === "renewal") {
          await this.pool.recordRenewalResult(account.id, failure);
        } else {
          await this.pool.recordQueryResult(account.id, failure);
        }
      } catch {
        // A status-write failure must not hide the provider result or stop siblings.
      }
      return withMailboxId(account, failure);
    } finally {
      this.completeOperation(active);
      if (this.operations.get(account.id) === active) {
        this.operations.delete(account.id);
        this.notifyOperationChange();
      }
    }
  }

  completeOperation(active) {
    if (active.completed) {
      return;
    }
    active.completed = true;
    active.batch.completed = Math.min(active.batch.total, active.batch.completed + 1);
  }

  notifyOperationChange() {
    try {
      this.onOperationChange(this.getActiveOperations());
    } catch {
      // A UI notification must never affect mailbox operation completion.
    }
  }
}

function createProviderSource(provider) {
  if (!provider) {
    throw new TypeError("Mailbox operation coordinator requires providers");
  }
  const normalized = provider.asProvider?.() ?? provider;
  return {
    get(id) {
      return id === normalized.id ? normalized : undefined;
    }
  };
}

function assertOperationProvider(provider) {
  if (!provider || typeof provider.query !== "function" || typeof provider.id !== "string") {
    throw new TypeError("Invalid mailbox provider");
  }
  return provider;
}

function selectAccounts(accounts, ids) {
  if (!ids) {
    return accounts;
  }
  const selectedIds = new Set(Array.isArray(ids) ? ids : [ids]);
  return accounts.filter((account) => selectedIds.has(account.id));
}

function findNewCodeMessages(messages, seen, startedAt) {
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    if (!message?.codes?.length) {
      return false;
    }
    const fingerprint = message.fingerprint ?? message.id;
    if (seen.has(fingerprint)) {
      return false;
    }
    return !message.receivedAt || Date.parse(message.receivedAt) >= startedAt;
  });
}

function uniqueCodes(messages) {
  return [...new Set(messages.flatMap((message) => message.codes ?? []))];
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

function withMailboxId(account, result) {
  return { ...result, mailboxId: account.id, address: account.address };
}

function sanitizePublicRenewalResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { account: _account, ...publicResult } = result;
  return publicResult;
}

function normalizeOperationError(error) {
  if (error?.name === "AbortError") {
    return { stage: "cancelled", code: "request_aborted", message: "Request cancelled", retryable: false };
  }
  return {
    stage: "operation",
    code: "operation_failed",
    message: error instanceof Error && error.message ? error.message.slice(0, 160) : "Mailbox operation failed",
    retryable: true
  };
}

function abortedResult(operation) {
  return {
    ok: false,
    operation,
    messages: [],
    codes: [],
    error: { stage: "cancelled", code: "request_aborted", message: "Request cancelled", retryable: false }
  };
}

function normalizePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("Request cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

module.exports = { MailboxOperationCoordinator, findNewCodeMessages, normalizeOperationError };
