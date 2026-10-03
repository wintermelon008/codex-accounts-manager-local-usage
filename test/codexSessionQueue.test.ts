import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { SessionQueueCoordinator } = require("../runtime/codex-session-queue.cjs") as {
  SessionQueueCoordinator: new (options?: { isThreadBusy?: (threadId: string) => boolean }) => {
    prepareOfficialRequest(message: Record<string, unknown>): Record<string, unknown>;
    handleChildResponse(message: Record<string, unknown>): Record<string, unknown>;
    handleNotification(message: Record<string, unknown>): Array<Record<string, unknown>>;
  };
};

function startRequest(id: string, threadId = "thread-1", input = "hello") {
  return {
    id,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: input }] }
  };
}

describe("Manager session queue coordinator", () => {
  it("queues a second turn and drains it once after completion", () => {
    const coordinator = new SessionQueueCoordinator();
    const first = startRequest("first");
    const second = startRequest("second", "thread-1", "queued");

    expect(coordinator.prepareOfficialRequest(first)).toMatchObject({ kind: "forward" });
    coordinator.handleChildResponse({ id: "first", result: { turn: { id: "turn-1" } } });
    expect(coordinator.prepareOfficialRequest(second)).toMatchObject({ kind: "queued", depth: 1 });

    const drained = coordinator.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
    expect(drained).toEqual([second]);
    expect(coordinator.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    })).toEqual([]);
  });

  it("does not resurrect a turn when completion arrives before its start response", () => {
    const coordinator = new SessionQueueCoordinator();
    const first = startRequest("late-first");
    const second = startRequest("late-second", "thread-1", "after completion");

    coordinator.prepareOfficialRequest(first);
    expect(coordinator.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-late", status: "completed" } }
    })).toEqual([]);
    expect(coordinator.prepareOfficialRequest(second)).toMatchObject({ kind: "forward" });

    const response = coordinator.handleChildResponse({
      id: "late-first",
      result: { turn: { id: "turn-late" } }
    });
    expect(response.childMessages).toEqual([]);
    expect(coordinator.handleChildResponse({
      id: "late-second",
      result: { turnId: "turn-second" }
    })).toMatchObject({ message: { id: "late-second" } });
  });

  it("converts one explicit no-active-turn steer failure into a fresh start", () => {
    const coordinator = new SessionQueueCoordinator();
    const steer = {
      id: "steer-1",
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        turnId: "stale-turn",
        input: [{ type: "text", text: "continue this" }],
        model: "gpt-test"
      }
    };

    expect(coordinator.prepareOfficialRequest(steer)).toMatchObject({ kind: "forward" });
    const retry = coordinator.handleChildResponse({
      id: "steer-1",
      error: { message: "No active turn to steer" }
    });
    expect(retry).toMatchObject({ suppress: true });
    const retryMessage = (retry.childMessages as Array<Record<string, unknown>>)[0];
    expect(retryMessage).toMatchObject({ method: "turn/start", params: { threadId: "thread-1", model: "gpt-test" } });
    expect((retryMessage.params as Record<string, unknown>).turnId).toBeUndefined();

    const result = coordinator.handleChildResponse({
      id: retryMessage.id as string,
      result: { turnId: "fresh-turn" }
    });
    expect(result).toMatchObject({ message: { id: "steer-1", result: { turnId: "fresh-turn" } } });
  });

  it("does not retry a steer while the Manager still sees an active turn", () => {
    const coordinator = new SessionQueueCoordinator({ isThreadBusy: () => true });
    const steer = {
      id: "steer-active",
      method: "turn/steer",
      params: { threadId: "thread-1", input: [{ type: "text", text: "do not duplicate" }] }
    };

    coordinator.prepareOfficialRequest(steer);
    const result = coordinator.handleChildResponse({
      id: "steer-active",
      error: { message: "No active turn to steer" }
    });
    expect(result).toEqual({
      message: { id: "steer-active", error: { message: "No active turn to steer" } },
      childMessages: []
    });
  });
});
