/**
 * Fails (exit 1) when the Node toolchain or the ed25519-dalek pin drift.
 *
 *   npm run check:toolchain
 *
 * See scripts/lib/toolchain-alignment-logic.ts (#896, #897).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDalekPin,
  checkNodeAlignment,
  collectNodeToolchain,
} from './lib/toolchain-alignment-logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function main() {
  const { runtimeMajor, problems: nodeProblems } = checkNodeAlignment(collectNodeToolchain(REPO_ROOT));
  const dalekProblems = checkDalekPin(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'tariff-shield', 'Cargo.toml'), 'utf-8'),
    fs.readFileSync(path.join(REPO_ROOT, 'Cargo.lock'), 'utf-8'),
  );
  const problems = [...nodeProblems, ...dalekProblems];

  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p.source}: ${p.message}`);
    process.exit(1);
  }
  console.log(`✓ Node toolchain aligned on Node ${runtimeMajor}; ed25519-dalek pin matches soroban-env-host`);
}

main();
