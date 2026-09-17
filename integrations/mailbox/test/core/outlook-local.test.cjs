"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  OutlookLocalProvider,
  parseOutlookLocalImport,
  parseOutlookLocalLine,
  parseRawEmail
} = require("../../src/core/providers/outlook-local.cjs");

test("local Outlook provider parses compact and legacy four-part rows without storing the legacy password", () => {
  assert.deepEqual(parseOutlookLocalLine("person@example.com----client-id----refresh-token"), {
    address: "person@example.com",
    credentials: { email: "person@example.com", clientId: "client-id", refreshToken: "refresh-token" }
  });
  assert.deepEqual(parseOutlookLocalLine("person@example.com----not-mail-password----client-id----refresh-token"), {
    address: "person@example.com",
    credentials: { email: "person@example.com", clientId: "client-id", refreshToken: "refresh-token" }
  });
  assert.equal(parseOutlookLocalImport("bad-row").failed.length, 1);
});

test("local Outlook provider exchanges refresh token, authenticates IMAP, and normalizes messages", async () => {
  const requests = [];
  const refreshed = [];
  const rawMessage = [
    "From: Microsoft <no-reply@example.com>",
    "Subject: =?UTF-8?B?5rWL6K+V?= 123456",
    "Date: Tue, 15 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use 123456 to continue."
  ].join("\r\n");
  const socket = new FakeImapSocket({ rawMessage: Buffer.from(rawMessage) });
  const provider = new OutlookLocalProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ access_token: "access-token", refresh_token: "rotated-refresh-token" });
    },
    tlsConnect: () => socket
  }).asProvider();

  const result = await provider.query({
    address: "person@example.com",
    credentials: { clientId: "client-id", refreshToken: "old-refresh-token" }
  }, {
    maxMessages: 2,
    onCredentialRefresh: async (account) => refreshed.push(account)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.messages[0].from, "no-reply@example.com");
  assert.equal(result.messages[0].subject, "测试 123456");
  assert.match(result.messages[0].body, /Use 123456/u);
  assert.equal(refreshed[0].credentials.refreshToken, "rotated-refresh-token");
  assert.equal(requests.length, 1);
  assert.match(requests[0].options.body, /client_id=client-id/u);
  assert.match(socket.commands.find((command) => command.includes("AUTHENTICATE XOAUTH2")), /AUTHENTICATE XOAUTH2/u);
  assert.match(socket.commands.find((command) => command.includes("UID FETCH")), /UID FETCH 41,42/u);
});

test("local Outlook provider caches access tokens until the refresh window", async () => {
  let now = 1_000_000;
  let tokenRequests = 0;
  const rawMessage = [
    "From: no-reply@example.com",
    "Subject: Code 123456",
    "Date: Tue, 15 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use 123456."
  ].join("\r\n");
  const provider = new OutlookLocalProvider({
    now: () => now,
    fetchImpl: async () => {
      tokenRequests += 1;
      return response({ access_token: `access-token-${tokenRequests}`, refresh_token: "rotated-refresh-token", expires_in: 3600 });
    },
    tlsConnect: () => new FakeImapSocket({ rawMessage: Buffer.from(rawMessage) })
  }).asProvider();
  const oldAccount = {
    address: "person@example.com",
    credentials: { clientId: "client-id", refreshToken: "old-refresh-token" }
  };
  const rotatedAccount = {
    address: oldAccount.address,
    credentials: { clientId: "client-id", refreshToken: "rotated-refresh-token" }
  };
  const refreshed = [];

  await provider.query(oldAccount, { maxMessages: 1, onCredentialRefresh: async (account) => refreshed.push(account) });
  await provider.query(rotatedAccount, { maxMessages: 1, onCredentialRefresh: async (account) => refreshed.push(account) });
  assert.equal(tokenRequests, 1);
  assert.equal(refreshed.length, 1);

  now += 56 * 60 * 1000;
  await provider.query(rotatedAccount, { maxMessages: 1, onCredentialRefresh: async (account) => refreshed.push(account) });
  assert.equal(tokenRequests, 2);
  assert.equal(refreshed.length, 1);
});

test("local Outlook provider coalesces concurrent first token exchanges", async () => {
  let tokenRequests = 0;
  const rawMessage = [
    "From: no-reply@example.com",
    "Subject: Code 123456",
    "Date: Tue, 15 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use 123456."
  ].join("\r\n");
  const provider = new OutlookLocalProvider({
    fetchImpl: async () => {
      tokenRequests += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return response({ access_token: "shared-access-token", expires_in: 3600 });
    },
    tlsConnect: () => new FakeImapSocket({ rawMessage: Buffer.from(rawMessage) })
  }).asProvider();
  const account = {
    address: "person@example.com",
    credentials: { clientId: "client-id", refreshToken: "refresh-token" }
  };

  const [first, second] = await Promise.all([
    provider.query(account, { maxMessages: 1 }),
    provider.query(account, { maxMessages: 1 })
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(tokenRequests, 1);
});

test("manual renewal returns a rotated refresh token without exposing an access token", async () => {
  const provider = new OutlookLocalProvider({
    fetchImpl: async () => response({ access_token: "access-token", refresh_token: "new-refresh-token" }),
    tlsConnect: () => {
      throw new Error("IMAP must not be contacted during renewal");
    }
  }).asProvider();

  const result = await provider.renew({
    address: "person@example.com",
    credentials: { clientId: "client-id", refreshToken: "old-refresh-token" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "updated");
  assert.equal(result.account.credentials.refreshToken, "new-refresh-token");
  assert.doesNotMatch(JSON.stringify(result), /access-token/u);
});

test("raw MIME parsing decodes quoted printable text", () => {
  const message = parseRawEmail(Buffer.from([
    "From: sender@example.com",
    "Subject: Code",
    "Date: Tue, 15 Sep 2026 10:00:00 +0000",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "验证码：=E7=94=B1=E4=BA=8E 654321"
  ].join("\r\n")), "42");

  assert.equal(message.from.emailAddress.address, "sender@example.com");
  assert.match(message.body, /验证码：由于 654321/u);
});

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

class FakeImapSocket extends EventEmitter {
  constructor({ rawMessage }) {
    super();
    this.rawMessage = rawMessage;
    this.commands = [];
    this.destroyed = false;
    setImmediate(() => {
      this.emit("secureConnect");
      this.emit("data", Buffer.from("* OK fake outlook imap\r\n"));
    });
  }

  setTimeout() {}

  write(value) {
    const command = String(value);
    this.commands.push(command);
    const match = command.match(/^(A\d+)\s+(.+?)\r?\n$/u);
    if (!match) {
      setImmediate(() => this.emit("data", Buffer.from(`${matchTag(this.commands)} OK\r\n`)));
      return true;
    }

    const [, tag, body] = match;
    if (/AUTHENTICATE XOAUTH2/iu.test(body)) {
      setImmediate(() => this.emit("data", Buffer.from("+ \r\n")));
      return true;
    }

    if (/^A\d+\s+[A-Za-z0-9+/=]+\r?\n$/u.test(command)) {
      setImmediate(() => this.emit("data", Buffer.from(`${tag} OK AUTHENTICATE completed\r\n`)));
      return true;
    }

    if (/SELECT INBOX/iu.test(body)) {
      setImmediate(() => this.emit("data", Buffer.from(`* 1 EXISTS\r\n${tag} OK SELECT completed\r\n`)));
      return true;
    }

    if (/UID SEARCH (?:ALL|SINCE)/iu.test(body)) {
      setImmediate(() => this.emit("data", Buffer.from(`* SEARCH 41 42\r\n${tag} OK SEARCH completed\r\n`)));
      return true;
    }

    if (/UID FETCH (?:41,)?42/iu.test(body)) {
      const prefix = Buffer.from(`* 42 FETCH (BODY[] {${this.rawMessage.length}}\r\n`);
      const suffix = Buffer.from(`)\r\n${tag} OK FETCH completed\r\n`);
      setImmediate(() => this.emit("data", Buffer.concat([prefix, this.rawMessage, suffix])));
      return true;
    }

    setImmediate(() => this.emit("data", Buffer.from(`${tag} OK completed\r\n`)));
    return true;
  }

  end() {
    this.destroyed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function matchTag(commands) {
  return [...commands].reverse().map((command) => command.match(/^(A\d+)/u)?.[1]).find(Boolean) || "A0000";
}
