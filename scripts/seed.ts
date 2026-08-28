/**
 * scripts/seed.ts
 *
 * Idempotent database seeder for TariffShield local development.
 *
 * Creates:
 *   - 1 surety_admin user
 *   - 2 demo importer accounts (+ a 3rd shortfall-scenario importer with --shortfall)
 *   - Sample contract events linked to demo importers
 *   - Representative tariff entries (via tariff_uploads)
 *
 * Usage:
 *   npm run seed                # base demo importers
 *   npm run seed -- --shortfall # also seeds demo-importer-shortfall@example.com,
 *                               # already in the shortfall state described in the
 *                               # README "Verification flow" (30 XLM collateral +
 *                               # 100 XLM reserve deposited, tariff upload driving
 *                               # required collateral to 80 XLM, so auto_top_up
 *                               # deterministically moves 50 XLM reserve → collateral)
 *
 * Environment (from apps/api/.env.example):
 *   SEED_ADMIN_PASSWORD=Admin#123
 *   SEED_IMPORTER_PASSWORD=Importer#123
 *
 * The script is safe to run multiple times (uses ON CONFLICT DO NOTHING).
 */

import { pool } from "../apps/api/src/db";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

// ── deterministic credentials (documented in .env.example) ──────────────────
const SEED_ADMIN_EMAIL = "surety_admin@example.com";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Admin#123";

const SEED_IMPORTERS = [
  { email: "demo-importer-1@example.com", password: process.env.SEED_IMPORTER_PASSWORD ?? "Importer#123", legalName: "Demo Importer One LLC", ein: "12-3456789", bondId: 1_000_000_000_000_001n },
  { email: "demo-importer-2@example.com", password: process.env.SEED_IMPORTER_PASSWORD ?? "Importer#123", legalName: "Demo Importer Two Corp", ein: "98-7654321", bondId: 1_000_000_000_000_002n },
];

// #1140 — `--shortfall`: a third importer that is already in the shortfall
// scenario the README "Verification flow" documents. Amounts are in stroops
// (7 decimals: 30 XLM = 300_000_000, 100 XLM = 1_000_000_000).
// required_collateral = annual_duty * 0.10 * 0.50 (see
// archives' POST /importers/:id/upload-tariff-csv), so an annual duty of
// 1600 XLM (16_000_000_000 stroops) produces 80 XLM (800_000_000 stroops)
// required — after the documented 30 XLM collateral deposit that leaves a
// 50 XLM shortfall that auto_top_up moves from the 100 XLM reserve.
const SHORTFALL = process.argv.includes("--shortfall");
const SEED_SHORTFALL_IMPORTER = {
  email: "demo-importer-shortfall@example.com",
  password: process.env.SEED_IMPORTER_PASSWORD ?? "Importer#123",
  legalName: "Demo Importer Shortfall LLC",
  ein: "55-6712390",
  bondId: 1_000_000_000_000_003n,
};
const SHORTFALL_DEPOSIT_COLLATERAL = 300_000_000; // 30 XLM — README step 3
const SHORTFALL_DEPOSIT_RESERVE = 1_000_000_000;  // 100 XLM — README step 3
const SHORTFALL_ANNUAL_DUTY = 16_000_000_000;     // 1600 XLM → README step 4
const SHORTFALL_REQUIRED = 800_000_000;           // 80 XLM (annual_duty × 10% × 50%)
const SHORTFALL_EXPECTED_MOVE = 500_000_000;      // 50 XLM = required − collateral

// ── helpers ──────────────────────────────────────────────────────────────────
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

async function upsertUser(email: string, passwordHash: string, role: "importer" | "surety_admin"): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, passwordHash, role]
  );
  return result.rows[0].id;
}

async function upsertImporter(userId: string, legalName: string, ein: string, bondId: bigint): Promise<string> {
  const result = await pool.query(
    `INSERT INTO importers (user_id, legal_name, ein, bond_id, stellar_address, stellar_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, bond_id = EXCLUDED.bond_id
     RETURNING id`,
    [userId, legalName, ein, bondId, `G${randomUUID().replace(/-/g, "").slice(0, 55)}`, "encrypted-placeholder"]
  );
  return result.rows[0].id;
}

async function insertContractEvent(importerId: string, kind: string, amount: number, txHash: string): Promise<void> {
  await pool.query(
    `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, raw)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [importerId, kind, amount, txHash, JSON.stringify({ seeded: true, kind })]
  );
}

async function insertTariffUpload(importerId: string, filename: string, annualDuty: number, collateral: number): Promise<void> {
  await pool.query(
    `INSERT INTO tariff_uploads (importer_id, filename, annual_duty_total, computed_required_collateral)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [importerId, filename, annualDuty, collateral]
  );
}

function printTable(rows: Array<Record<string, unknown>>, columns: string[]): void {
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)));
  const fmt = (vals: unknown[]) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(fmt(columns.map((c) => row[c] ?? "")));
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n🌱 TariffShield Seeder\n");

  const adminHash = await hashPassword(SEED_ADMIN_PASSWORD);
  const adminId = await upsertUser(SEED_ADMIN_EMAIL, adminHash, "surety_admin");

  const importerResults: Array<{ email: string; password: string; userId: string; importerId: string }> = [];

  for (const imp of SEED_IMPORTERS) {
    const hash = await hashPassword(imp.password);
    const userId = await upsertUser(imp.email, hash, "importer");
    const importerId = await upsertImporter(userId, imp.legalName, imp.ein, imp.bondId);
    importerResults.push({ email: imp.email, password: imp.password, userId, importerId });
  }

  // Contract events per importer
  const eventKinds = [
    { kind: "BOND_ISSUED", amount: 500_000 },
    { kind: "YIELD_ACCRUED", amount: 12_500 },
    { kind: "COVERAGE_USED", amount: 75_000 },
  ];

  for (const imp of importerResults) {
    for (const evt of eventKinds) {
      await insertContractEvent(imp.importerId, evt.kind, evt.amount, `0x${randomUUID().replace(/-/g, "")}`);
    }
  }

  // Tariff uploads covering HS codes with varying duty rates
  const tariffEntries = [
    { importerId: importerResults[0]!.importerId, filename: "hs_8501_motors.csv", annualDuty: 45_000, collateral: 22_500 },
    { importerId: importerResults[0]!.importerId, filename: "hs_8471_computers.csv", annualDuty: 12_000, collateral: 6_000 },
    { importerId: importerResults[1]!.importerId, filename: "hs_8703_vehicles.csv", annualDuty: 128_000, collateral: 64_000 },
    { importerId: importerResults[1]!.importerId, filename: "hs_8517_phones.csv", annualDuty: 8_500, collateral: 4_250 },
  ];

  for (const entry of tariffEntries) {
    await insertTariffUpload(entry.importerId, entry.filename, entry.annualDuty, entry.collateral);
  }

  // ── #1140: shortfall scenario (--shortfall) ────────────────────────────────
  let shortfallImporterResult:
    | { email: string; password: string; userId: string; importerId: string }
    | undefined;

  if (SHORTFALL) {
    const imp = SEED_SHORTFALL_IMPORTER;
    const hash = await hashPassword(imp.password);
    const userId = await upsertUser(imp.email, hash, "importer");
    const importerId = await upsertImporter(userId, imp.legalName, imp.ein, imp.bondId);
    shortfallImporterResult = { email: imp.email, password: imp.password, userId, importerId };

    // README "Verification flow" state: deposits + tariff upload already
    // applied, so required_collateral (80 XLM) exceeds collateral (30 XLM).
    for (const evt of [
      { kind: "register", amount: 0 },
      { kind: "deposit_collateral", amount: SHORTFALL_DEPOSIT_COLLATERAL },
      { kind: "deposit_reserve", amount: SHORTFALL_DEPOSIT_RESERVE },
      { kind: "required_changed", amount: SHORTFALL_REQUIRED },
    ]) {
      await insertContractEvent(importerId, evt.kind, evt.amount, `0x${randomUUID().replace(/-/g, "")}`);
    }

    await insertTariffUpload(
      importerId,
      "hs_8541_semiconductors.csv",
      SHORTFALL_ANNUAL_DUTY,
      SHORTFALL_REQUIRED
    );
  }

  // Summary
  console.log("\n✅ Seed complete — created resources:\n");
  printTable(
    [
      ...importerResults.map((imp) => ({ type: "importer", email: imp.email, password: imp.password, id: imp.userId })),
      { type: "surety_admin", email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD, id: adminId },
    ],
    ["type", "email", "password", "id"]
  );

  if (SHORTFALL && shortfallImporterResult) {
    console.log(
      `\n🔻 Shortfall demo importer seeded (${shortfallImporterResult.email}).\n` +
        `   Required collateral: ${Number(SHORTFALL_REQUIRED) / 1e7} XLM (annual duty 1600 XLM × 10% × 50%)\n` +
        `   Deposited: ${Number(SHORTFALL_DEPOSIT_COLLATERAL) / 1e7} XLM collateral + ${Number(SHORTFALL_DEPOSIT_RESERVE) / 1e7} XLM reserve\n` +
        `   Expected auto_top_up: ${Number(SHORTFALL_EXPECTED_MOVE) / 1e7} XLM moved reserve → collateral (matches README)\n` +
        `   Exercise it with:\n` +
        `     npm run admin -- auto-top-up --importer-id ${shortfallImporterResult.importerId}\n`
    );
  }

  console.log("\n💡 Tip: copy these credentials into your API client to log in.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
