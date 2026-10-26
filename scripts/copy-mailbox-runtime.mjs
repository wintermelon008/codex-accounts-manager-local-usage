#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const sourceRoot = path.join(repositoryRoot, "integrations", "mailbox", "src");
const outputRoot = path.join(repositoryRoot, "out", "mailbox");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outputRoot), { recursive: true });
await cp(sourceRoot, outputRoot, { recursive: true });
console.log(`Mailbox runtime copied to ${path.relative(repositoryRoot, outputRoot)}`);
