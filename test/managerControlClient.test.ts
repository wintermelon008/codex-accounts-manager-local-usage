import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerControlClient } from "../src/integrations/managerControlClient";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("ManagerControlClient", () => {
  it("submits a refresh job, polls it, and preserves the account scope", async () => {
    let requestBody = "";
    let pollCount = 0;
    const server = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer control-secret") {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "POST") {
        request.on("data", (chunk: Buffer) => {
          requestBody += chunk.toString("utf8");
        });
        request.on("end", () => {
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "refresh-job", type: "quota_refresh", state: "running", createdAt: 1 }));
        });
        return;
      }
      pollCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "refresh-job",
          type: "quota_refresh",
          state: "completed",
          createdAt: 1,
          completedAt: 2,
          result: {
            total: 2,
            succeeded: 2,
            failed: 0,
            unknownAccountIds: [],
            failedAccountIds: []
          }
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    const client = new ManagerControlClient({
      getPort: () => address.port,
      getToken: () => "control-secret",
      pollIntervalMs: 1,
      requestTimeoutMs: 1_000,
      jobTimeoutMs: 1_000
    });
    const dispatch = await client.refreshQuotas(["account-a", "account-b"]);

    expect(JSON.parse(requestBody)).toEqual({ accountIds: ["account-a", "account-b"] });
    expect(pollCount).toBeGreaterThanOrEqual(1);
    expect(dispatch).toMatchObject({
      timedOut: false,
      job: { id: "refresh-job", state: "completed", result: { succeeded: 2 } }
    });
  });

  it("returns undefined before submitting when no usable control port exists", async () => {
    const client = new ManagerControlClient({
      getPort: () => 0,
      getToken: () => "control-secret"
    });

    await expect(client.refreshQuotas(["account-a"])).resolves.toBeUndefined();
  });
});
