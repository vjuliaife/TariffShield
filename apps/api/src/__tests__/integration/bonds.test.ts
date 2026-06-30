/**
 * Integration tests for bond record persistence against a real PostgreSQL instance.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 * The CI workflow runs `npm run db:migrate` before invoking this suite.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/tariffshield_test";

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const testEmail = `integration-bonds-${testTag}@example.com`;

let userId: string;
let importerId: string;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe("bonds integration — real Postgres insert", () => {
  before(async () => {
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [testEmail, "test-hash-not-real", "importer"],
    );
    userId = userResult.rows[0]!.id;

    const importerResult = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, "Integration Test Corp", testBondId, "GABC1234TESTSTELLARADDRESS00000000000000000000000000000000"],
    );
    importerId = importerResult.rows[0]!.id;
  });

  after(async () => {
    if (importerId) {
      await pool.query("DELETE FROM bond_records WHERE importer_id = $1", [importerId]);
      await pool.query("DELETE FROM importers WHERE id = $1", [importerId]);
    }
    if (userId) {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
    await pool.end();
  });

  it("inserts a bond record and retrieves it", async () => {
    const result = await pool.query<{ id: string; bond_id: string; bond_amount: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE)
       RETURNING id, bond_id, bond_amount`,
      [
        importerId,
        testBondId,
        "02",
        "Integration Test Corp",
        "12-3456789",
        "Test Surety Company",
        "98-7654321",
        "500000",
        "100000",
      ],
    );

    assert.strictEqual(result.rowCount, 1, "one row should be inserted");
    const row = result.rows[0]!;
    assert.ok(row.id, "inserted row should have a UUID id");
    assert.strictEqual(String(row.bond_id), String(testBondId), "bond_id should match");
    assert.strictEqual(row.bond_amount, "500000", "bond_amount should match");
  });

  it("enforces bond_type_code check constraint", async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO bond_records
             (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
              surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE)`,
          [
            importerId,
            testBondId + 1,
            "99",
            "Integration Test Corp",
            "12-3456789",
            "Test Surety Company",
            "98-7654321",
            "500000",
            "100000",
          ],
        ),
      /violates check constraint/i,
      "invalid bond_type_code should raise a check constraint error",
    );
  });
});
