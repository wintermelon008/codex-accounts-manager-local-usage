import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(packageRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true, mode: 0o700 });
