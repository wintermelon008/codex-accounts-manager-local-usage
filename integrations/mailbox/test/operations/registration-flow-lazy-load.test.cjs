"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("registration flow does not load Playwright during module initialization", () => {
  const modulePath = path.resolve(__dirname, "../../src/operations/registration-flow.cjs");
  const script = `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "playwright") throw new Error("Playwright was loaded eagerly");
      return originalLoad.call(this, request, parent, isMain);
    };
    require(${JSON.stringify(modulePath)});
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
