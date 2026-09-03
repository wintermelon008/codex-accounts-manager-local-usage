import { describe, expect, it } from "vitest";
import { parseManagerControlToken } from "../src/infrastructure/config/managerControlEnvironment";

describe("Manager control environment", () => {
  it("parses an exported token assignment", () => {
    expect(parseManagerControlToken("export CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN=control-secret\n")).toBe(
      "control-secret"
    );
  });

  it("strips matching shell quotes", () => {
    expect(parseManagerControlToken("CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN='control-secret'\n")).toBe(
      "control-secret"
    );
  });

  it("does not accept an empty assignment", () => {
    expect(parseManagerControlToken("CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN=\n")).toBeUndefined();
  });
});
