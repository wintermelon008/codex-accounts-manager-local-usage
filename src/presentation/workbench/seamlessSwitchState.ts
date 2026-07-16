import * as vscode from "vscode";
import { didQuotaBandDrop } from "../../application/accounts/balanceScheduler";

type SeamlessSwitchRuntimeState = {
  hourlyBands?: Record<string, number>;
  lastSelectedAt?: Record<string, number>;
};

type LegacyAutoSwitchRuntimeState = {
  hourlyBands?: Record<string, number>;
  balanceLastSelectedAt?: Record<string, number>;
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
  state.lastSelectedAt = { ...(saved?.lastSelectedAt ?? legacy?.balanceLastSelectedAt ?? {}) };
  if (!saved && (legacy?.hourlyBands || legacy?.balanceLastSelectedAt)) {
    persist();
  }
}

export function getSeamlessSwitchRuntimeSnapshot(): SeamlessSwitchRuntimeState {
  return {
    hourlyBands: { ...(state.hourlyBands ?? {}) },
    lastSelectedAt: { ...(state.lastSelectedAt ?? {}) }
  };
}

export function observeSeamlessQuotaBand(accountId: string, currentBand: number): boolean {
  const previousBand = state.hourlyBands?.[accountId];
  const dropped = didQuotaBandDrop(previousBand, currentBand);
  if (!dropped && previousBand !== currentBand) {
    state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
    persist();
  }
  return dropped;
}

export function acknowledgeSeamlessQuotaBand(accountId: string, currentBand: number): void {
  state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
  persist();
}

export function recordSeamlessSelection(accountId: string, currentBand: number): void {
  state.hourlyBands = { ...(state.hourlyBands ?? {}), [accountId]: currentBand };
  state.lastSelectedAt = { ...(state.lastSelectedAt ?? {}), [accountId]: Date.now() };
  persist();
}

export function resetSeamlessSwitchRuntimeState(): void {
  state.hourlyBands = {};
  state.lastSelectedAt = {};
  persist();
}

function persist(): void {
  void extensionContext?.globalState.update(GLOBAL_STATE_KEY, {
    hourlyBands: state.hourlyBands,
    lastSelectedAt: state.lastSelectedAt
  });
}
