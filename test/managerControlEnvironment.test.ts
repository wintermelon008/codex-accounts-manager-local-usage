import { describe, expect, it } from "vitest";
import {
  parseManagerControlToken,
  parseNoProxy,
  parseSharingRelayBootstrapToken,
} from "../src/infrastructure/config/managerControlEnvironment";

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

  it("parses the sharing Relay bootstrap token from the same environment file", () => {
    expect(
      parseSharingRelayBootstrapToken("export CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN=sharing-secret\n")
    ).toBe("sharing-secret");
  });

  it("parses a private-network no-proxy list from the same environment file", () => {
    expect(parseNoProxy("export NO_PROXY=127.0.0.1,localhost,vserver.tailff5c81.ts.net\n")).toBe(
      "127.0.0.1,localhost,vserver.tailff5c81.ts.net"
    );
  });
});
