/**
 * Tiny .env loader for scripts (tsx does not read .env by itself, unlike Next).
 * Existing process.env values always win, so CI overrides still work.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(path = ".env"): boolean {
  try {
    const text = readFileSync(resolve(process.cwd(), path), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (key === undefined || process.env[key] !== undefined) continue;
      let value = match[2] ?? "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}
