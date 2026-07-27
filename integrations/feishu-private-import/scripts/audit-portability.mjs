import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "vendor", "templates", "README.md", "package.json"];
const forbidden = [
  /\/home\//u,
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
  /"(?:sk|pk|xox)[_-][A-Za-z0-9]/u
];
const violations = [];

for (const root of roots) {
  await inspect(path.join(packageRoot, root));
}

if (violations.length > 0) {
  throw new Error(`portability audit failed: ${violations.join(", ")}`);
}
console.log("portability audit passed");

async function inspect(target) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    const content = await readFile(target, "utf8");
    if (forbidden.some((pattern) => pattern.test(content))) {
      violations.push(path.relative(packageRoot, target));
    }
    return;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await inspect(child);
    } else if (entry.isFile()) {
      await inspect(child);
    }
  }
}
