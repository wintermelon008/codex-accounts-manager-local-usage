"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const forbidden = [
  /\/home\//u,
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}/u
];

for (const target of ["README.md", "package.json", "src", "scripts", "templates"]) {
  for (const file of walk(path.join(root, target))) {
    const content = fs.readFileSync(file, "utf8");
    if (forbidden.some((pattern) => pattern.test(content))) {
      throw new Error(`Portability audit failed for ${path.relative(root, file)}`);
    }
  }
}

process.stdout.write("portability audit passed\n");

function* walk(target) {
  const info = fs.statSync(target);
  if (info.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const next = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(next);
    if (entry.isFile()) yield next;
  }
}
