import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSharingRelay } from "../src/sharing-relay.mjs";
import { createGatewayServer, listen } from "../src/server.mjs";

const servers = [];
const directories = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Manager sharing Relay", () => {
  it("registers users, routes requests and returns encrypted transfers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "manager-sharing-relay-"));
    directories.push(directory);
    const relay = createSharingRelay({ stateDir: directory, bootstrapToken: "enroll-secret" });
    const server = createGatewayServer({
      sessions: { maxSessions: 1 },
      config: { server: { host: "127.0.0.1", port: 0, token: undefined, corsOrigin: "*" } },
      sharingRelay: relay
    });
    servers.push(server);
    const address = await listen(server, "127.0.0.1", 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const profileA = {
      userId: "rw_user_a_1234567890",
      displayName: "A",
      identityPublicKey: "identity-a",
      encryptionPublicKey: "encryption-a"
    };
    const profileB = {
      userId: "rw_user_b_1234567890",
      displayName: "B",
      identityPublicKey: "identity-b",
      encryptionPublicKey: "encryption-b"
    };
    const register = async (profile) => {
      const response = await fetch(`${baseUrl}/v1/sharing/register`, {
        method: "POST",
        headers: {
          authorization: "Bearer enroll-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify(profile)
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const accountA = await register(profileA);
    const accountB = await register(profileB);
    const authA = { authorization: `Bearer ${accountA.mailboxToken}` };
    const authB = { authorization: `Bearer ${accountB.mailboxToken}` };

    const me = await fetch(`${baseUrl}/v1/sharing/me`, { headers: authB });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).userId, profileB.userId);

    const lookup = await fetch(`${baseUrl}/v1/sharing/users/${profileB.userId}`, { headers: authA });
    assert.equal(lookup.status, 200);
    assert.equal((await lookup.json()).displayName, "B");

    const request = await fetch(`${baseUrl}/v1/sharing/requests`, {
      method: "POST",
      headers: { ...authA, "content-type": "application/json" },
      body: JSON.stringify({ toUserId: profileB.userId })
    });
    assert.equal(request.status, 201);
    const requestBody = await request.json();

    const inbox = await fetch(`${baseUrl}/v1/sharing/requests/inbox`, { headers: authB });
    assert.deepEqual((await inbox.json()).requests.map((item) => item.fromUserId), [profileA.userId]);
    const accepted = await fetch(`${baseUrl}/v1/sharing/requests/${requestBody.id}/accept`, {
      method: "POST",
      headers: authB
    });
    assert.equal(accepted.status, 200);

    const transfer = await fetch(`${baseUrl}/v1/sharing/transfers`, {
      method: "POST",
      headers: { ...authA, "content-type": "application/json" },
      body: JSON.stringify({
        recipientUserId: profileB.userId,
        expiresAt: Date.now() + 60_000,
        envelope: { schema: "encrypted", ciphertext: "opaque" }
      })
    });
    assert.equal(transfer.status, 201);
    const transferBody = await transfer.json();
    assert.equal(transferBody.expiresAt > Date.now(), true);

    const transferInbox = await fetch(`${baseUrl}/v1/sharing/transfers/inbox`, { headers: authB });
    assert.equal((await transferInbox.json()).transfers[0].envelope.ciphertext, "opaque");

    const ack = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}/ack`, {
      method: "POST",
      headers: { ...authB, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", imported: 1, poolEnabled: 1 })
    });
    assert.equal(ack.status, 200);

    const returned = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}/return`, {
      method: "POST",
      headers: authB
    });
    assert.equal((await returned.json()).state, "returned");

    const sent = await fetch(`${baseUrl}/v1/sharing/transfers/sent`, { headers: authA });
    assert.equal((await sent.json()).transfers[0].state, "returned");

    const removed = await fetch(`${baseUrl}/v1/sharing/peers/${profileB.userId}/remove`, {
      method: "POST",
      headers: authA
    });
    assert.deepEqual(await removed.json(), { removed: true, peerUserId: profileB.userId });
    const requestsAfterRemoval = await fetch(`${baseUrl}/v1/sharing/requests/mine`, { headers: authA });
    assert.equal((await requestsAfterRemoval.json()).requests[0].state, "revoked");
  });

  it("keeps partial returns visible to the sender and lets the sender cancel an unconfirmed hand-off", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "manager-sharing-relay-partial-"));
    directories.push(directory);
    const relay = createSharingRelay({ stateDir: directory, bootstrapToken: "enroll-secret" });
    const server = createGatewayServer({
      sessions: { maxSessions: 1 },
      config: { server: { host: "127.0.0.1", port: 0, token: undefined, corsOrigin: "*" } },
      sharingRelay: relay
    });
    servers.push(server);
    const address = await listen(server, "127.0.0.1", 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const profileA = {
      userId: "rw_partial_a_1234567890",
      displayName: "A",
      identityPublicKey: "identity-a",
      encryptionPublicKey: "encryption-a"
    };
    const profileB = {
      userId: "rw_partial_b_1234567890",
      displayName: "B",
      identityPublicKey: "identity-b",
      encryptionPublicKey: "encryption-b"
    };
    const register = async (profile) => {
      const response = await fetch(`${baseUrl}/v1/sharing/register`, {
        method: "POST",
        headers: {
          authorization: "Bearer enroll-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify(profile)
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const accountA = await register(profileA);
    const accountB = await register(profileB);
    const authA = { authorization: `Bearer ${accountA.mailboxToken}` };
    const authB = { authorization: `Bearer ${accountB.mailboxToken}` };

    const transfer = await fetch(`${baseUrl}/v1/sharing/transfers`, {
      method: "POST",
      headers: { ...authA, "content-type": "application/json" },
      body: JSON.stringify({
        recipientUserId: profileB.userId,
        expiresAt: Date.now() + 60_000,
        envelope: { schema: "encrypted", ciphertext: "opaque" }
      })
    });
    assert.equal(transfer.status, 201);
    const transferBody = await transfer.json();

    const ack = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}/ack`, {
      method: "POST",
      headers: { ...authB, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", imported: 2, poolEnabled: 2 })
    });
    assert.equal(ack.status, 200);

    const partialReturn = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}/return`, {
      method: "POST",
      headers: { ...authB, "content-type": "application/json" },
      body: JSON.stringify({
        accountIds: ["account-one"],
        returnEnvelope: { accountIds: ["account-one"], envelope: { schema: "return", ciphertext: "opaque-return" } }
      })
    });
    const partialBody = await partialReturn.json();
    assert.equal(partialBody.state, "delivered");
    assert.deepEqual(partialBody.returnedAccountIds, ["account-one"]);
    assert.equal(partialBody.returnEnvelopes[0].envelope.ciphertext, "opaque-return");

    const sent = await fetch(`${baseUrl}/v1/sharing/transfers/sent`, { headers: authA });
    const sentBody = await sent.json();
    assert.deepEqual(sentBody.transfers[0].returnedAccountIds, ["account-one"]);

    const confirmation = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}/confirm-return`, {
      method: "POST",
      headers: { ...authA, "content-type": "application/json" },
      body: JSON.stringify({ accountIds: ["account-one"] })
    });
    assert.deepEqual((await confirmation.json()).ownerConfirmedAccountIds, ["account-one"]);
    const recipientStatus = await fetch(`${baseUrl}/v1/sharing/transfers/${transferBody.id}`, { headers: authB });
    assert.deepEqual((await recipientStatus.json()).ownerConfirmedAccountIds, ["account-one"]);

    const secondTransfer = await fetch(`${baseUrl}/v1/sharing/transfers`, {
      method: "POST",
      headers: { ...authA, "content-type": "application/json" },
      body: JSON.stringify({
        recipientUserId: profileB.userId,
        expiresAt: Date.now() + 60_000,
        envelope: { schema: "encrypted", ciphertext: "opaque-2" }
      })
    });
    const secondTransferBody = await secondTransfer.json();
    const cancelled = await fetch(`${baseUrl}/v1/sharing/transfers/${secondTransferBody.id}/cancel`, {
      method: "POST",
      headers: authA
    });
    assert.equal((await cancelled.json()).state, "cancelled");
  });

  it("expires an unconfirmed transfer when either side polls after its lease deadline", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "manager-sharing-relay-expiry-"));
    directories.push(directory);
    let clock = 1_000;
    const relay = createSharingRelay({ stateDir: directory, bootstrapToken: "enroll-secret", now: () => clock });
    const server = createGatewayServer({
      sessions: { maxSessions: 1 },
      config: { server: { host: "127.0.0.1", port: 0, token: undefined, corsOrigin: "*" } },
      sharingRelay: relay
    });
    servers.push(server);
    const address = await listen(server, "127.0.0.1", 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const profiles = [
      {
        userId: "rw_expiry_a_1234567890",
        displayName: "A",
        identityPublicKey: "identity-a",
        encryptionPublicKey: "encryption-a"
      },
      {
        userId: "rw_expiry_b_1234567890",
        displayName: "B",
        identityPublicKey: "identity-b",
        encryptionPublicKey: "encryption-b"
      }
    ];
    const auth = [];
    for (const profile of profiles) {
      const response = await fetch(`${baseUrl}/v1/sharing/register`, {
        method: "POST",
        headers: { authorization: "Bearer enroll-secret", "content-type": "application/json" },
        body: JSON.stringify(profile)
      });
      assert.equal(response.status, 201);
      auth.push({ authorization: `Bearer ${(await response.json()).mailboxToken}` });
    }

    const created = await fetch(`${baseUrl}/v1/sharing/transfers`, {
      method: "POST",
      headers: { ...auth[0], "content-type": "application/json" },
      body: JSON.stringify({
        recipientUserId: profiles[1].userId,
        expiresAt: 1_500,
        envelope: { schema: "encrypted", ciphertext: "opaque" }
      })
    });
    assert.equal(created.status, 201);
    const transferId = (await created.json()).id;

    clock = 1_501;
    const sent = await fetch(`${baseUrl}/v1/sharing/transfers/sent`, { headers: auth[0] });
    assert.equal(sent.status, 200);
    const transfer = (await sent.json()).transfers.find((item) => item.id === transferId);
    assert.equal(transfer.state, "cancelled");
    assert.equal(transfer.result.message, "sharing lease expired before confirmation");
  });

  it("routes one-shot reads and automatic usage updates through an active credential sync", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "manager-sharing-relay-usage-"));
    directories.push(directory);
    const relay = createSharingRelay({ stateDir: directory, bootstrapToken: "enroll-secret" });
    const server = createGatewayServer({
      sessions: { maxSessions: 1 },
      config: { server: { host: "127.0.0.1", port: 0, token: undefined, corsOrigin: "*" } },
      sharingRelay: relay
    });
    servers.push(server);
    const address = await listen(server, "127.0.0.1", 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const profiles = [
      {
        userId: "rw_usage_a_1234567890",
        displayName: "Primary",
        identityPublicKey: "identity-a",
        encryptionPublicKey: "encryption-a"
      },
      {
        userId: "rw_usage_b_1234567890",
        displayName: "Follower",
        identityPublicKey: "identity-b",
        encryptionPublicKey: "encryption-b"
      }
    ];
    const auth = [];
    for (const profile of profiles) {
      const response = await fetch(`${baseUrl}/v1/sharing/register`, {
        method: "POST",
        headers: { authorization: "Bearer enroll-secret", "content-type": "application/json" },
        body: JSON.stringify(profile)
      });
      assert.equal(response.status, 201);
      auth.push({ authorization: `Bearer ${(await response.json()).mailboxToken}` });
    }

    const friendRequest = await fetch(`${baseUrl}/v1/sharing/requests`, {
      method: "POST",
      headers: { ...auth[0], "content-type": "application/json" },
      body: JSON.stringify({ toUserId: profiles[1].userId })
    });
    const friendRequestId = (await friendRequest.json()).id;
    const accepted = await fetch(`${baseUrl}/v1/sharing/requests/${friendRequestId}/accept`, {
      method: "POST",
      headers: auth[1]
    });
    assert.equal(accepted.status, 200);

    const sync = await fetch(`${baseUrl}/v1/sharing/credential-syncs`, {
      method: "POST",
      headers: { ...auth[0], "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "usage-sync-12345678",
        recipientUserId: profiles[1].userId,
        version: 1,
        eventId: "credential-event-1234",
        envelope: { ciphertext: "credentials-opaque" }
      })
    });
    assert.equal(sync.status, 201);

    const created = await fetch(`${baseUrl}/v1/sharing/usage-requests`, {
      method: "POST",
      headers: { ...auth[0], "content-type": "application/json" },
      body: JSON.stringify({ syncIds: ["usage-sync-12345678"] })
    });
    assert.equal(created.status, 201);
    const request = (await created.json()).requests[0];

    const followerInbox = await fetch(`${baseUrl}/v1/sharing/credential-syncs/inbox`, { headers: auth[1] });
    const inboxBody = await followerInbox.json();
    assert.equal(inboxBody.usageRequests[0].id, request.id);
    assert.equal(inboxBody.usageRequests[0].toUserId, profiles[1].userId);

    const response = await fetch(`${baseUrl}/v1/sharing/usage-requests/${request.id}/response`, {
      method: "POST",
      headers: { ...auth[1], "content-type": "application/json" },
      body: JSON.stringify({
        revision: 3,
        eventId: "usage-event-123456",
        envelope: { ciphertext: "usage-opaque" }
      })
    });
    assert.equal(response.status, 200);

    const primarySent = await fetch(`${baseUrl}/v1/sharing/credential-syncs/sent`, { headers: auth[0] });
    const sentBody = await primarySent.json();
    assert.equal(sentBody.usageRequests[0].response.revision, 3);
    assert.equal(sentBody.usageRequests[0].response.envelope.ciphertext, "usage-opaque");

    const acknowledged = await fetch(`${baseUrl}/v1/sharing/usage-requests/${request.id}/ack`, {
      method: "POST",
      headers: auth[0]
    });
    assert.equal(acknowledged.status, 200);
    const afterAck = await fetch(`${baseUrl}/v1/sharing/credential-syncs/sent`, { headers: auth[0] });
    assert.deepEqual((await afterAck.json()).usageRequests, []);

    const update = await fetch(`${baseUrl}/v1/sharing/usage-updates`, {
      method: "POST",
      headers: { ...auth[1], "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "usage-sync-12345678",
        revision: 7,
        eventId: "usage-update-event-123456",
        envelope: { ciphertext: "usage-update-opaque" }
      })
    });
    assert.equal(update.status, 201);

    const primaryInboxWithUpdate = await fetch(`${baseUrl}/v1/sharing/credential-syncs/inbox`, { headers: auth[0] });
    const inboxWithUpdateBody = await primaryInboxWithUpdate.json();
    assert.equal(inboxWithUpdateBody.usageUpdates[0].revision, 7);
    assert.equal(inboxWithUpdateBody.usageUpdates[0].envelope.ciphertext, "usage-update-opaque");

    const updateAcknowledged = await fetch(
      `${baseUrl}/v1/sharing/usage-updates/usage-sync-12345678/ack`,
      {
        method: "POST",
        headers: { ...auth[0], "content-type": "application/json" },
        body: JSON.stringify({ revision: 7 })
      }
    );
    assert.equal(updateAcknowledged.status, 200);
    const afterUpdateAck = await fetch(`${baseUrl}/v1/sharing/credential-syncs/inbox`, { headers: auth[0] });
    assert.deepEqual((await afterUpdateAck.json()).usageUpdates, []);
  });
});
