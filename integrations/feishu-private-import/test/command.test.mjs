import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isImportCommand, parseImportCommand } from "../src/command.mjs";

describe("private import command recognition", () => {
  it("recognizes M+ and S+ without changing their payload", () => {
    const payload = '{"email":"person@example.invalid","access_token":"value"}';
    assert.deepEqual(parseImportCommand(`m+ ${payload}`), { target: "manager", action: "import", argument: payload });
    assert.deepEqual(parseImportCommand(`S+ ${payload}`), { target: "sub2api", action: "import", argument: payload });
    assert.deepEqual(parseImportCommand(`<at user_id="bot">bot</at> Manager 导入 ${payload}`), {
      target: "manager",
      action: "import",
      argument: payload
    });
  });

  it("recognizes Manager status/help without treating ordinary messages as imports", () => {
    assert.deepEqual(parseImportCommand("Manager 导入状态 abc"), {
      target: "manager",
      action: "status",
      argument: "abc"
    });
    assert.deepEqual(parseImportCommand("m+ 帮助"), { target: "manager", action: "help", argument: "" });
    assert.equal(isImportCommand("查询店铺 availability"), false);
  });
});
