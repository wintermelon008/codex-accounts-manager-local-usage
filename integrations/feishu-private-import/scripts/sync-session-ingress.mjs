import { readFile, mkdir, copyFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(scriptDirectory, "../../session-ingress/src");
const targetDirectory = path.resolve(scriptDirectory, "../vendor/session-ingress");
const files = ["index.mjs", "normalizer.mjs", "queue.mjs"];
const checkOnly = process.argv.includes("--check");

for (const file of files) {
  const source = path.join(sourceDirectory, file);
  const target = path.join(targetDirectory, file);
  let equal = false;
  try {
    equal = (await readFile(source, "utf8")) === (await readFile(target, "utf8"));
  } catch {
    equal = false;
  }
  if (equal) {
    continue;
  }
  if (checkOnly) {
    throw new Error(`vendored session-ingress file is stale: ${file}`);
  }
  await mkdir(targetDirectory, { recursive: true });
  await copyFile(source, target);
}
