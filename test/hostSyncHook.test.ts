import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => {
  let ref: { current: unknown } | undefined;
  let dependencies: readonly unknown[] | undefined;
  let cleanup: (() => void) | undefined;

  const sameDependencies = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    reset(): void {
      ref = undefined;
      dependencies = undefined;
      cleanup = undefined;
    },
    useRef<T>(initialValue: T): { current: T } {
      ref ??= { current: initialValue };
      return ref as { current: T };
    },
    useEffect(effect: () => void | (() => void), nextDependencies?: readonly unknown[]): void {
      if (sameDependencies(dependencies, nextDependencies)) {
        return;
      }
      cleanup?.();
      cleanup = effect() ?? undefined;
      dependencies = nextDependencies;
    }
  };
});

const { postMessageToHostMock } = vi.hoisted(() => ({
  postMessageToHostMock: vi.fn()
}));

vi.mock("preact/hooks", () => ({
  useEffect: hookHarness.useEffect,
  useRef: hookHarness.useRef
}));

vi.mock("../webview-src/dashboard/host", () => ({
  postMessageToHost: postMessageToHostMock
}));

import { useDashboardHostSync } from "../webview-src/dashboard/hostSyncHook";

describe("Dashboard host synchronization", () => {
  const listeners = new Map<string, (event: unknown) => void>();

  beforeEach(() => {
    hookHarness.reset();
    postMessageToHostMock.mockReset();
    listeners.clear();
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      })
    });
  });

  it("sends ready once while keeping message handlers current across rerenders", () => {
    const firstMessageHandler = vi.fn();
    const firstEscapeHandler = vi.fn(() => true);
    useDashboardHostSync({
      handleHostMessage: firstMessageHandler,
      handleEscape: firstEscapeHandler
    });

    const secondMessageHandler = vi.fn();
    const secondEscapeHandler = vi.fn(() => true);
    useDashboardHostSync({
      handleHostMessage: secondMessageHandler,
      handleEscape: secondEscapeHandler
    });

    expect(postMessageToHostMock).toHaveBeenCalledOnce();
    expect(postMessageToHostMock).toHaveBeenCalledWith({ type: "dashboard:ready" });

    listeners.get("message")?.({ data: { type: "dashboard:snapshot" } });
    listeners.get("keydown")?.({ key: "Escape" });
    expect(firstMessageHandler).not.toHaveBeenCalled();
    expect(firstEscapeHandler).not.toHaveBeenCalled();
    expect(secondMessageHandler).toHaveBeenCalledOnce();
    expect(secondEscapeHandler).toHaveBeenCalledOnce();
  });
});
