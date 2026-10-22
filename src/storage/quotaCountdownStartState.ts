import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { CodexAccountRecord } from "../core/types";

const STATE_FILE_NAME = "quota-countdown-start-state.v1.json";
const STATE_VERSION = 1;

export type QuotaCountdownStartRecord = {
  cycleKey: string;
  status: "attempting" | "accepted" | "uncertain";
  updatedAt: number;
};

type QuotaCountdownStartState = {
  version: 1;
  accounts: Record<string, QuotaCountdownStartRecord>;
};

export function getQuotaCountdownStartStatePath(privateRoot: string): string {
  return path.join(privateRoot, STATE_FILE_NAME);
}

export function getQuotaCountdownCycleKey(account: CodexAccountRecord): string | undefined {
  const quota = account.quotaSummary;
  if (!quota) {
    return undefined;
  }

  const hourly =
    quota.hourlyWindowPresent === true ? `hourly:${formatResetTime(quota.hourlyResetTime)}` : "hourly:absent";
  const weekly =
    quota.weeklyWindowPresent === true ? `weekly:${formatResetTime(quota.weeklyResetTime)}` : "weekly:absent";
  return `${hourly}|${weekly}`;
}

export async function readQuotaCountdownStartRecord(
  privateRoot: string,
  accountId: string
): Promise<QuotaCountdownStartRecord | undefined> {
  const state = await readState(privateRoot);
  return state.accounts[accountId];
}

export async function writeQuotaCountdownStartRecord(
  privateRoot: string,
  accountId: string,
  record: QuotaCountdownStartRecord
): Promise<void> {
  const state = await readState(privateRoot);
  state.accounts[accountId] = { ...record };
  await writeState(privateRoot, state);
}

export async function clearQuotaCountdownStartRecord(privateRoot: string, accountId: string): Promise<void> {
  const state = await readState(privateRoot);
  if (!(accountId in state.accounts)) {
    return;
  }
  delete state.accounts[accountId];
  await writeState(privateRoot, state);
}

async function readState(privateRoot: string): Promise<QuotaCountdownStartState> {
  try {
    const raw = JSON.parse(
      await readFile(getQuotaCountdownStartStatePath(privateRoot), "utf8")
    ) as Partial<QuotaCountdownStartState>;
    if (raw.version !== STATE_VERSION || !isRecord(raw.accounts)) {
      throw new Error("Invalid quota countdown start state version");
    }

    const accounts: Record<string, QuotaCountdownStartRecord> = {};
    Object.entries(raw.accounts).forEach(([accountId, value]) => {
      if (!isRecord(value)) {
        throw new Error(`Invalid quota countdown start record for ${accountId}`);
      }
      const status = value.status;
      if (
        typeof value.cycleKey !== "string" ||
        (status !== "attempting" && status !== "accepted" && status !== "uncertain") ||
        typeof value.updatedAt !== "number" ||
        !Number.isFinite(value.updatedAt)
      ) {
        throw new Error(`Invalid quota countdown start record for ${accountId}`);
      }
      accounts[accountId] = {
        cycleKey: value.cycleKey,
        status,
        updatedAt: value.updatedAt
      };
    });
    return { version: STATE_VERSION, accounts };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { version: STATE_VERSION, accounts: {} };
    }
    throw error;
  }
}

async function writeState(privateRoot: string, state: QuotaCountdownStartState): Promise<void> {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const statePath = getQuotaCountdownStartStatePath(privateRoot);
  const temporaryPath = path.join(privateRoot, `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function formatResetTime(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
