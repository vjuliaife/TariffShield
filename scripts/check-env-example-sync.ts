import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { diffEnvKeys } from "./lib/env-example-sync-logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, "..", "apps", "api", ".env.example");
const ROOT_PATH = path.join(__dirname, "..", ".env.example");

const { values } = parseArgs({ options: { write: { type: "boolean" } } });

const source = fs.readFileSync(SOURCE_PATH, "utf-8");

if (values.write) {
  fs.writeFileSync(ROOT_PATH, source);
  console.log("✓ Regenerated .env.example from apps/api/.env.example.");
  process.exit(0);
}

const { missing, extra } = diffEnvKeys(source, fs.readFileSync(ROOT_PATH, "utf-8"));
if (missing.length === 0 && extra.length === 0) {
  console.log("✓ .env.example and apps/api/.env.example declare the same variables.");
  process.exit(0);
}

console.error("❌ .env.example has drifted from apps/api/.env.example (the source of truth):");
if (missing.length > 0) console.error(`  missing from .env.example: ${missing.join(", ")}`);
if (extra.length > 0) console.error(`  only in .env.example: ${extra.join(", ")}`);
console.error("Edit apps/api/.env.example, then run `npm run sync:env-example`.");
process.exit(1);
