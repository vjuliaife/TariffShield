import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { diffEnvKeys, extractEnvKeys } from "../lib/env-example-sync-logic.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("extractEnvKeys", () => {
  it("collects active and commented-out variable declarations", () => {
    const keys = extractEnvKeys("# [Required] note\nPORT=3002\n# SAML_SP_ENTITY_ID=https://x\n");
    assert.deepEqual([...keys].sort(), ["PORT", "SAML_SP_ENTITY_ID"]);
  });

  it("ignores prose comments and blank lines", () => {
    const keys = extractEnvKeys("# Note: keep in sync\n\n# Tier key: [Required] = set\n");
    assert.equal(keys.size, 0);
  });
});

describe("diffEnvKeys", () => {
  it("reports no drift for identical key sets", () => {
    assert.deepEqual(diffEnvKeys("A=1\nB=2\n", "B=x\nA=y\n"), { missing: [], extra: [] });
  });

  it("reports keys missing from and extra in the root copy", () => {
    assert.deepEqual(diffEnvKeys("A=1\nB=2\n", "B=2\nC=3\n"), { missing: ["A"], extra: ["C"] });
  });
});

describe("committed example files", () => {
  it("root .env.example declares the same variables as apps/api/.env.example", () => {
    const source = fs.readFileSync(path.join(repoRoot, "apps", "api", ".env.example"), "utf-8");
    const root = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf-8");
    assert.deepEqual(diffEnvKeys(source, root), { missing: [], extra: [] });
  });
});
