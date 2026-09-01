import * as vscode from "vscode";
import { didQuotaBandDrop } from "../../application/accounts/balanceScheduler";
import type { SeamlessQuotaBandSize } from "../../core/types";

type SeamlessSwitchRuntimeState = {
  hourlyBands?: Record<string, number>;
  quotaBandSize?: SeamlessQuotaBandSize;
};

type LegacyAutoSwitchRuntimeState = {
  hourlyBands?: Record<string, number>;
};

const GLOBAL_STATE_KEY = "codexAccounts.seamlessSwitchRuntimeState";
const LEGACY_GLOBAL_STATE_KEY = "codexAccounts.autoSwitchRuntimeState";

const state: SeamlessSwitchRuntimeState = {};
let extensionContext: vscode.ExtensionContext | undefined;

export function initSeamlessSwitchRuntimeState(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const saved = context.globalState.get<SeamlessSwitchRuntimeState>(GLOBAL_STATE_KEY);
  const legacy = context.globalState.get<LegacyAutoSwitchRuntimeState>(LEGACY_GLOBAL_STATE_KEY);
  state.hourlyBands = { ...(saved?.hourlyBands ?? legacy?.hourlyBands ?? {}) };
  state.quotaBandSize = saved?.quotaBandSize;
  if (!saved && legacy?.hourlyBands) {
    persist();
  }
}

export function getSeamlessSwitchRuntimeSnapshot(): SeamlessSwitchRuntimeState {
  return {
    hourlyBands: { ...(state.hourlyBands ?? {}) },
    quotaBandSize: state.quotaBandSize
  };
}

export function observeSeamlessQuotaBand(
  accountId: string,
  currentBand: number,
  quotaBandSize: SeamlessQuotaBandSize = 20
): boolean {
  if (state.quotaBandSize !== quotaBandSize) {
    state.hourlyBands = { [accountId]: currentBand };
    state.quotaBandSize = quotaBandSize;
    persist();
    return false;
  }
  const previousBand = state.hourlyBands?.[accountId];
  const dropped = didQuotaBandDrop(previousBand, currentBand);
  if (!dropped && previousBand !== currentBand) {
    state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
    persist();
  }
  return dropped;
}

export function acknowledgeSeamlessQuotaBand(
  accountId: string,
  currentBand: number,
  quotaBandSize: SeamlessQuotaBandSize = 20
): void {
  state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
  state.quotaBandSize = quotaBandSize;
  persist();
}

export function recordSeamlessSelection(
  accountId: string,
  currentBand: number | undefined,
  quotaBandSize: SeamlessQuotaBandSize = 20
): void {
  if (currentBand !== undefined) {
    state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
  } else {
    const hourlyBands = { ...(state.hourlyBands ?? {}) };
    delete hourlyBands[accountId];
    state.hourlyBands = hourlyBands;
  }
  state.quotaBandSize = quotaBandSize;
  persist();
}

export function resetSeamlessSwitchRuntimeState(): void {
  state.hourlyBands = {};
  state.quotaBandSize = undefined;
  persist();
}

function persist(): void {
  void extensionContext?.globalState.update(GLOBAL_STATE_KEY, {
    hourlyBands: state.hourlyBands,
    quotaBandSize: state.quotaBandSize
  });
}
