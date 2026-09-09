import { describe, expect, it } from "vitest";
import { selectAuthRevocationCandidates } from "../src/application/accounts/authRevocationSwitch";
import type { CodexAccountRecord } from "../src/core/types";

function account(
  id: string,
  overrides: Partial<CodexAccountRecord> = {}
): CodexAccountRecord {
  return {
    id,
    email: id + "@example.invalid",
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    isActive: id === "active",
    balancePoolEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

const allGroupsVisible = {
  get<T>(_section: string, defaultValue?: T): T {
    return defaultValue as T;
  }
};

describe("token-revocation switch candidates", () => {
  it("only returns visible pooled ChatGPT accounts in Dashboard order", () => {
    const accounts = [
      account("active"),
      account("fallback-b", { accountGroup: "B" }),
      account("fallback-a", { accountGroup: "A" }),
      account("hidden", { isHidden: true }),
      account("manual", { manualOnly: true }),
      account("outside-pool", { balancePoolEnabled: false })
    ];

    expect(
      selectAuthRevocationCandidates(accounts, "active", allGroupsVisible, [
        "active",
        "fallback-a",
        "fallback-b"
      ]).map((candidate) => candidate.id)
    ).toEqual(["fallback-a", "fallback-b"]);
    expect(
      selectAuthRevocationCandidates(
        accounts,
        "active",
        allGroupsVisible,
        ["active", "fallback-a", "fallback-b"],
        new Set(["fallback-a"])
      ).map((candidate) => candidate.id)
    ).toEqual(["fallback-b"]);
  });

  it("honors hidden account groups and always excludes the active account", () => {
    const accounts = [
      account("active", { accountGroup: "A" }),
      account("group-a", { accountGroup: "A" }),
      account("group-b", { accountGroup: "B" })
    ];
    const onlyGroupBVisible = {
      get<T>(section: string, _defaultValue?: T): T {
        return (section === "seamlessSwitchGroupBVisible" ? true : false) as T;
      }
    };

    expect(selectAuthRevocationCandidates(accounts, "active", onlyGroupBVisible).map((candidate) => candidate.id)).toEqual(
      ["group-b"]
    );
  });
});
