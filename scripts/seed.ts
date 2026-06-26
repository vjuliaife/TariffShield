/**
 * scripts/seed.ts
 *
 * Idempotent database seeder for TariffShield local development.
 *
 * Creates:
 *   - 1 surety_admin user
 *   - 2 demo importer accounts
 *   - Sample contract events linked to demo importers
 *   - Representative tariff entries (via tariff_uploads)
 *
 * Usage:
 *   npm run seed
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
  { email: "demo-importer-1@example.com", password: process.env.SEED_IMPORTER_PASSWORD ?? "Importer#123", legalName: "Demo Importer One LLC", ein: "12-3456789" },
  { email: "demo-importer-2@example.com", password: process.env.SEED_IMPORTER_PASSWORD ?? "Importer#123", legalName: "Demo Importer Two Corp", ein: "98-7654321" },
];

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

async function upsertImporter(userId: string, legalName: string, ein: string): Promise<string> {
  const bondId = Math.floor(Math.random() * 9_000_000_000_000_000) + 1_000_000_000_000_000;
  const result = await pool.query(
    `INSERT INTO importers (user_id, legal_name, ein, bond_id, stellar_address, stellar_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET legal_name = EXCLUDED.legal_name
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
    const importerId = await upsertImporter(userId, imp.legalName, imp.ein);
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

  // Summary
  console.log("\n✅ Seed complete — created resources:\n");
  printTable(
    [
      ...importerResults.map((imp) => ({ type: "importer", email: imp.email, password: imp.password, id: imp.userId })),
      { type: "surety_admin", email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD, id: adminId },
    ],
    ["type", "email", "password", "id"]
  );

  console.log("\n💡 Tip: copy these credentials into your API client to log in.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
