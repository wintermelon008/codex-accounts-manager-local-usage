import { existsSync } from "node:fs";
import * as path from "node:path";

/** Resolve the compiled Mailbox module, with a source-checkout fallback. */
export function resolveMailboxRuntimeRoot(): string {
  const compiledRoot = path.resolve(__dirname, "../mailbox");
  if (existsSync(path.join(compiledRoot, "ui", "integration.cjs"))) {
    return compiledRoot;
  }

  const sourceRoot = path.resolve(__dirname, "../../integrations/mailbox/src");
  if (existsSync(path.join(sourceRoot, "ui", "integration.cjs"))) {
    return sourceRoot;
  }

  throw new Error("The bundled Mailbox runtime is unavailable");
}
