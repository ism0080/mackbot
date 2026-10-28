import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest starts under plain Node, which does not read the repo-root `.env`.
 * The Worker's secrets are `Config.Redacted`, so they must be in `process.env`
 * before Alchemy resolves them during `deploy(Stack)`.
 *
 * Real environment variables win: CI supplies them directly, and the file is
 * only the developer's local copy.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "..", "..", "..", ".env");

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) continue;
    const [, key, raw] = match;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = raw!.replace(/^["']|["']$/gu, "");
  }
}
