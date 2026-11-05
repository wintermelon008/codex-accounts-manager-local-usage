import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_USAGE_STATE_SCHEMA,
  createEmptyAccountUsageState,
  getAccountUsageStatePath,
  readAccountUsageState,
  writeAccountUsageState
} from "../src/sharing/accountUsage";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shared account usage state", () => {
  it("writes an isolated private cache without changing sharing state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-shared-usage-"));
    directories.push(root);
    const sharingPath = path.join(root, "sharing-local-state-v1.json");
    const sharingState = '{"version":1,"state":{"credentialSyncs":[{"syncId":"sync-existing"}]}}\n';
    await writeFile(sharingPath, sharingState, { encoding: "utf8", mode: 0o600 });

    await writeAccountUsageState(root, {
      schema: ACCOUNT_USAGE_STATE_SCHEMA,
      pendingRequests: [
        {
          requestId: "usage-request",
          syncId: "sync-existing",
          createdAt: 100,
          expiresAt: 200
        }
      ],
      sources: [
        {
          syncId: "sync-existing",
          sourceUserId: "rw_follower_1234567890",
          sourceDisplayName: "U280",
          revision: 3,
          calculatedAt: 150,
          receivedAt: 160,
          accounts: [{ accountId: "account-existing" }]
        }
      ]
    });

    expect(await readFile(sharingPath, "utf8")).toBe(sharingState);
    await expect(readAccountUsageState(root)).resolves.toMatchObject({
      schema: ACCOUNT_USAGE_STATE_SCHEMA,
      pendingRequests: [{ requestId: "usage-request", syncId: "sync-existing" }],
      sources: [{ syncId: "sync-existing", sourceUserId: "rw_follower_1234567890" }]
    });
    const usageStateStat = await stat(getAccountUsageStatePath(root));
    expect(usageStateStat.mode & 0o777).toBe(0o600);
  });

  it("ignores malformed persisted state instead of exposing it to the dashboard", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-shared-usage-invalid-"));
    directories.push(root);
    await writeFile(
      getAccountUsageStatePath(root),
      JSON.stringify({
        schema: "unexpected",
        pendingRequests: [{ requestId: 12 }],
        sources: [{ syncId: "sync", accounts: [null] }]
      })
    );

    await expect(readAccountUsageState(root)).resolves.toEqual(createEmptyAccountUsageState());
  });
});
