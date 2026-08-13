"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const roots = ["README.md", "package.json", "src"].map((entry) => path.join(root, entry));
const forbidden = [
  /\/home\//u,
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}/u
];

for (const entry of roots) {
  for (const file of walk(entry)) {
    const content = fs.readFileSync(file, "utf8");
    if (forbidden.some((pattern) => pattern.test(content))) {
      throw new Error(`Portability audit failed for ${path.relative(root, file)}`);
    }
  }
}

process.stdout.write("Mailbox portability audit passed\n");

function* walk(target) {
  const info = fs.statSync(target);
  if (info.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      yield* walk(path.join(target, entry.name));
    } else if (entry.isFile()) {
      yield path.join(target, entry.name);
    }
  }
}
