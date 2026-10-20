/**
 * Integration tests for listSuretyAdminImporters (#250) against a real
 * PostgreSQL instance.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 * The CI workflow runs `npm run db:migrate` before invoking this suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { listSuretyAdminImporters } from '../../db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const IMPORTER_COUNT = 5;

describe('listSuretyAdminImporters integration (#250)', () => {
  const userIds: string[] = [];
  const importerIds: string[] = [];
  const bondRecordIds: string[] = [];

  before(async () => {
    for (let i = 0; i < IMPORTER_COUNT; i++) {
      const bondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

      const userRes = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [`surety-list-${testTag}-${i}@example.com`, 'test-hash-not-real', 'importer']
      );
      const userId = userRes.rows[0]!.id;
      userIds.push(userId);

      const importerRes = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, `Importer ${testTag} ${i}`, bondId, `G${testTag}${i}`.padEnd(56, 'A')]
      );
      const importerId = importerRes.rows[0]!.id;
      importerIds.push(importerId);

      // Give every importer two bond_records rows, newest last, to confirm
      // the LEFT JOIN LATERAL picks the most recent one rather than an
      // arbitrary/duplicated row.
      await pool.query(
        `INSERT INTO bond_records
           (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
            surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, created_at)
         VALUES ($1, $2, '02', $3, '00-0000000', 'Test Surety Co', '00-0000001', $4, $5, now() - interval '1 year', now() - interval '1 year')`,
        [importerId, bondId, `Importer ${testTag} ${i}`, '50000', '40000']
      );
      const latestBond = await pool.query<{ id: string }>(
        `INSERT INTO bond_records
           (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
            surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, created_at)
         VALUES ($1, $2, '02', $3, '00-0000000', 'Test Surety Co', '00-0000001', $4, $5, now(), now())
         RETURNING id`,
        [importerId, bondId, `Importer ${testTag} ${i}`, '75000', '60000']
      );
      bondRecordIds.push(latestBond.rows[0]!.id);
    }

    await pool.query('REFRESH MATERIALIZED VIEW importer_metrics');
  });

  after(async () => {
    for (const id of importerIds) {
      await pool.query('DELETE FROM bond_records WHERE importer_id = $1', [id]);
      await pool.query('DELETE FROM importers WHERE id = $1', [id]);
    }
    for (const id of userIds) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
    await pool.end();
  });

  it('returns exactly `limit` rows and the correct total count', async () => {
    const page = await listSuretyAdminImporters(1, 2);

    assert.equal(page.importers.length, 2);
    assert.ok(page.total >= IMPORTER_COUNT, 'total should include at least the seeded importers');
    assert.equal(page.page, 1);
    assert.equal(page.limit, 2);
  });

  it('paginates without overlapping or skipping rows across pages', async () => {
    const page1 = await listSuretyAdminImporters(1, 3);
    const page2 = await listSuretyAdminImporters(2, 3);

    const ids1 = new Set(page1.importers.map((i) => i.id));
    const ids2 = new Set(page2.importers.map((i) => i.id));
    for (const id of ids1) {
      assert.ok(!ids2.has(id), `importer ${id} appeared on both page 1 and page 2`);
    }
  });

  it('resolves each importer\'s most recent bond_records row via the LATERAL join, not an older one', async () => {
    const page = await listSuretyAdminImporters(1, 100);
    const seeded = page.importers.filter((i) => importerIds.includes(i.id));

    assert.equal(seeded.length, IMPORTER_COUNT);
    for (const imp of seeded) {
      assert.equal(imp.bondAmount, '75000', `expected the newer bond_records row for importer ${imp.id}`);
      assert.equal(imp.cbpMinimumRequired, '60000');
    }
  });

  it('includes the user email via the users JOIN', async () => {
    const page = await listSuretyAdminImporters(1, 100);
    const seeded = page.importers.filter((i) => importerIds.includes(i.id));

    for (const imp of seeded) {
      assert.ok(imp.email.startsWith(`surety-list-${testTag}-`), `unexpected email for importer ${imp.id}`);
    }
  });

  it('includes metrics fields (current_balance, coverage_ratio) from importer_metrics', async () => {
    const page = await listSuretyAdminImporters(1, 100);
    const seeded = page.importers.filter((i) => importerIds.includes(i.id));

    for (const imp of seeded) {
      assert.notEqual(imp.currentBalance, undefined);
      assert.notEqual(imp.coverageRatio, undefined);
    }
  });
});
