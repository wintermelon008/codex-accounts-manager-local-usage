import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it, vi } from "vitest";
import type { AccountHealthKind } from "../src/domain/accountHealth";
import type { DashboardAccountViewModel } from "../src/domain/dashboard/types";
import { ActionButton } from "../webview-src/dashboard/primitives";
import { SavedAccountCard } from "../webview-src/dashboard/savedAccountCard";
import { renderHealthPill } from "../webview-src/dashboard/accountMetricPrimitives";

vi.mock("preact/hooks", () => ({ useState: () => [false, vi.fn()] }));

type CardProps = Parameters<typeof SavedAccountCard>[0];
type ButtonProps = Parameters<typeof ActionButton>[0];

function renderCard(
  healthKind: AccountHealthKind,
  accountOverrides: Partial<DashboardAccountViewModel> = {},
  busy = false
) {
  const onAction = vi.fn();
  const tree = SavedAccountCard({
    account: {
      id: "selected-account",
      email: "test@example.invalid",
      accountKind: "chatgpt",
      healthKind,
      healthLabel: "状态提示",
      metrics: [],
      tags: [],
      ...accountOverrides
    } as DashboardAccountViewModel,
    lang: "zh",
    copy: { reauthorizeBtn: "重新认证" } as CardProps["copy"],
    settings: {} as CardProps["settings"],
    now: Date.now(),
    privacyMode: false,
    busy,
    reloadPromptPending: false,
    switchPending: false,
    reauthorizePending: false,
    refreshPending: false,
    copyImportJsonPending: false,
    copyImportJsonSucceeded: false,
    accountNameCopyPending: false,
    accountNameCopySucceeded: false,
    quotaCountdownStartPending: false,
    removePending: false,
    poolTogglePending: false,
    consumeResetCreditPending: false,
    providerActionPending: false,
    selected: false,
    onToggleSelected: vi.fn(),
    onAction
  });
  const buttons: VNode<ButtonProps>[] = [];
  function visit(node: ComponentChildren): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object" || !("type" in node)) return;
    if (node.type === ActionButton) buttons.push(node as VNode<ButtonProps>);
    visit(node.props.children);
  }
  visit(tree);
  return { tree, button: buttons.find((node) => node.props.label === "重新认证"), onAction };
}

describe("saved account reauthorization key", () => {
  it.each<AccountHealthKind>(["refresh_failed", "refresh_token_invalid"])(
    "offers the existing key on yellow %s cards without making them red",
    (kind) => {
      const { tree, button, onAction } = renderCard(kind);
      expect(tree.props.class).toContain("health-warning");
      expect(tree.props.class).not.toContain("health-error");
      expect(button?.props.disabled).toBe(false);
      button?.props.onClick();
      expect(onAction).toHaveBeenCalledExactlyOnceWith("reauthorize", "selected-account");
    }
  );

  it.each([{}, { isActive: true }, { isHidden: true }])(
    "uses cyan for confirmed-usable renewal failure: %j",
    (overrides) => {
      const { tree, button, onAction } = renderCard("refresh_unavailable", overrides);
      expect(tree.props.class).toContain("health-usable");
      expect(tree.props.class).not.toContain("health-warning");
      expect(tree.props.class).not.toContain("health-unknown");
      expect(button?.props.disabled).toBe(false);
      button?.props.onClick();
      expect(onAction).toHaveBeenCalledExactlyOnceWith("reauthorize", "selected-account");
    }
  );

  it.each([{}, { isActive: true }, { isHidden: true }])(
    "gives unknown availability its own yellow card and an account-bound key: %j",
    (overrides) => {
      const { tree, button, onAction } = renderCard("refresh_unavailable_unverified", overrides);
      expect(tree.props.class).toContain("health-unknown");
      expect(tree.props.class).not.toContain("health-warning");
      expect(tree.props.class).not.toContain("health-error");
      expect(button?.props.disabled).toBe(false);
      button?.props.onClick();
      expect(onAction).toHaveBeenCalledExactlyOnceWith("reauthorize", "selected-account");
    }
  );

  it.each<AccountHealthKind>(["reauthorize", "access_token_invalid"])("keeps the existing key for %s", (kind) => {
    expect(renderCard(kind).button).toBeDefined();
  });

  it("never renders a separate gray unknown state", () => {
    const { tree, button, onAction } = renderCard("unverified", { isHidden: true });
    expect(tree.props.class).toContain("health-unknown");
    expect(button?.props.disabled).toBe(false);
    button?.props.onClick();
    expect(onAction).toHaveBeenCalledExactlyOnceWith("reauthorize", "selected-account");
  });

  it.each([
    ["refresh_unavailable", "pill health-usable"],
    ["refresh_unavailable_unverified", "pill health-unknown"],
    ["unverified", "pill health-unknown"],
    ["refresh_failed", "pill warning"]
  ] as const)("maps %s to its updated color class", (kind, className) => {
    const pill = renderHealthPill({ healthKind: kind, healthLabel: "原中文标签" } as DashboardAccountViewModel);
    expect(pill?.props.class).toBe(className);
    expect(pill?.props.children).toBe("原中文标签");
  });

  it.each<AccountHealthKind>(["healthy", "quota", "expiring"])("does not add a key to %s", (kind) => {
    expect(renderCard(kind).button).toBeUndefined();
  });

  it("preserves dismissed, virtual, manual-only and busy behavior", () => {
    expect(renderCard("refresh_unavailable", { dismissedHealth: true }).button).toBeUndefined();
    expect(renderCard("refresh_unavailable", { accountKind: "sub2api" }).button).toBeUndefined();
    expect(renderCard("refresh_unavailable", { manualOnly: true }).button).toBeUndefined();
    expect(renderCard("refresh_unavailable", {}, true).button?.props.disabled).toBe(true);
  });
});
