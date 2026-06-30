/**
 * Verification test script for the regulatory compliance report API.
 *
 * Assumes the API server is running at http://localhost:3002.
 * Run with: npx tsx scripts/test-regulatory-report.ts
 *
 * Tests:
 *   1. JSON report for a licensed state returns 200 with correct shape
 *   2. CSV format returns text/csv content-type
 *   3. Unlicensed state returns 403
 *   4. Second identical request gets X-Cache: HIT
 *   5. Audit log entry is created in the DB
 */

import "dotenv/config";
import { pool } from "../apps/api/src/db.js";

const BASE = "http://localhost:3002";
const SURETY_EMAIL = `test-surety-${Date.now()}@regulatory.test`;
const SURETY_PASSWORD = "TestPassword123!";
const TEST_STATE = "TX";

// Simple fetch wrapper that throws on unexpected status
async function apiFetch(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const { token, ...rest } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(rest.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...rest, headers });
  const contentType = res.headers.get("content-type") ?? "";
  let body: any;
  if (contentType.includes("text/csv")) {
    body = await res.text();
  } else {
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
  }

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  return { status: res.status, body, headers: respHeaders };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log("=== Regulatory Report API — Verification Script ===\n");

  // ── Step 1: Sign up a surety_admin test user ─────────────────────────────
  console.log("1. Creating test surety_admin...");
  const signupRes = await apiFetch("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: SURETY_EMAIL,
      password: SURETY_PASSWORD,
      role: "surety_admin",
      accept_tos: true,
    }),
  });
  assert(signupRes.status === 200, `Signup returned 200 (got ${signupRes.status})`);
  const token: string = signupRes.body?.token;
  const userId: string = signupRes.body?.user?.id;
  assert(!!token, "JWT token received");
  assert(!!userId, "User ID received");

  if (!token || !userId) {
    console.error("\nFatal: could not sign up test user. Aborting.");
    process.exit(1);
  }

  // ── Step 2: Insert a test license for TX via DB ───────────────────────────
  console.log("\n2. Seeding test state license for TX...");
  await pool.query(
    `INSERT INTO surety_state_licenses (surety_id, state_code, license_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (surety_id, state_code) DO NOTHING`,
    [userId, TEST_STATE, "TX-SUR-TEST-001"],
  );
  console.log("  ✅ License record inserted");

  // ── Step 3: JSON report — licensed state ─────────────────────────────────
  console.log("\n3. GET /api/v1/regulatory/state-report/TX (JSON)...");
  const jsonRes = await apiFetch(`/api/v1/regulatory/state-report/${TEST_STATE}`, { token });
  assert(jsonRes.status === 200, `Status 200 (got ${jsonRes.status})`);
  assert(jsonRes.body?.stateCode === TEST_STATE, `stateCode === '${TEST_STATE}'`);
  assert(typeof jsonRes.body?.stats?.totalBondsWritten === "number", "stats.totalBondsWritten is a number");
  assert(typeof jsonRes.body?.stats?.claimsFiled === "number", "stats.claimsFiled is a number");
  assert(Array.isArray(jsonRes.body?.importerSegmentation), "importerSegmentation is an array");
  assert(jsonRes.headers["x-cache"] === "MISS", "First request: X-Cache: MISS");

  // ── Step 4: Cache hit on second request ──────────────────────────────────
  console.log("\n4. Second request — cache hit...");
  const cachedRes = await apiFetch(`/api/v1/regulatory/state-report/${TEST_STATE}`, { token });
  assert(cachedRes.status === 200, `Status 200 (got ${cachedRes.status})`);
  assert(cachedRes.headers["x-cache"] === "HIT", "Second request: X-Cache: HIT");

  // ── Step 5: CSV format ────────────────────────────────────────────────────
  console.log("\n5. GET /api/v1/regulatory/state-report/TX?format=csv...");
  const csvRes = await apiFetch(`/api/v1/regulatory/state-report/${TEST_STATE}?format=csv`, { token });
  assert(csvRes.status === 200, `Status 200 (got ${csvRes.status})`);
  assert(
    (csvRes.headers["content-type"] ?? "").includes("text/csv"),
    `Content-Type: text/csv (got ${csvRes.headers["content-type"]})`,
  );
  assert(typeof csvRes.body === "string" && csvRes.body.includes("State Code"), "CSV contains header row");

  // ── Step 6: Unlicensed state returns 403 ─────────────────────────────────
  console.log("\n6. GET /api/v1/regulatory/state-report/NY (unlicensed) → 403...");
  const forbiddenRes = await apiFetch("/api/v1/regulatory/state-report/NY", { token });
  assert(forbiddenRes.status === 403, `Status 403 (got ${forbiddenRes.status})`);

  // ── Step 7: Verify audit log entry in DB ─────────────────────────────────
  console.log("\n7. Checking audit log in DB...");
  const auditCheck = await pool.query(
    "SELECT COUNT(*) as cnt FROM regulatory_report_audit_logs WHERE surety_id = $1 AND state_code = $2",
    [userId, TEST_STATE],
  );
  const auditCount = parseInt(auditCheck.rows[0]?.cnt ?? "0", 10);
  assert(auditCount >= 1, `Audit log entry exists (found ${auditCount})`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log("\n8. Cleaning up test data...");
  await pool.query("DELETE FROM surety_state_licenses WHERE surety_id = $1", [userId]);
  await pool.query("DELETE FROM regulatory_report_audit_logs WHERE surety_id = $1", [userId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  console.log("  ✅ Cleanup complete");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  pool.end();
  process.exit(1);
});
