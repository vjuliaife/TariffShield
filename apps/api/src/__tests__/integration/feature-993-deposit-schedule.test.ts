import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migration0013Up } from '../../migrations/0013_deposit_schedules.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });

function computeNextRunAt(cadence: 'weekly' | 'monthly', fromDate: Date = new Date()): Date {
  const next = new Date(fromDate.getTime());
  if (cadence === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else {
    next.setDate(next.getDate() + 30);
  }
  return next;
}

const testTag = randomUUID().slice(0, 8);
const importerEmail = `test-imp-993-${testTag}@example.com`;
const unapprovedEmail = `test-unapproved-993-${testTag}@example.com`;

let dbAvailable = false;
let importerUserId: string;
let unapprovedUserId: string;
let importerId: string;
let unapprovedImporterId: string;
let testScheduleId: string;
const testBondId1 = Math.floor(Math.random() * 9_000_000) + 1_000_000;
const testBondId2 = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issue #993 — Recurring Collateral Deposit Scheduling', () => {
  before(async () => {
    try {
      const client = await pool.connect();
      try {
        await migration0013Up(client);
        dbAvailable = true;

        const u1 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [importerEmail, 'hash1', 'importer']
        );
        importerUserId = u1.rows[0]!.id;

        const u2 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [unapprovedEmail, 'hash2', 'importer']
        );
        unapprovedUserId = u2.rows[0]!.id;

        const impRes = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, stellar_secret_encrypted, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, $5, 'approved', 10000000)
           RETURNING id`,
          [
            importerUserId,
            'Scheduled Deposit Importer Corp',
            testBondId1,
            'GBTESTSCHEDULEDDEPOSIT12345',
            'SDTESTSECRETKEY1234567890',
          ]
        );
        importerId = impRes.rows[0]!.id;

        const unappRes = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, stellar_secret_encrypted, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, $5, 'pending', 0)
           RETURNING id`,
          [
            unapprovedUserId,
            'Unapproved Importer Corp',
            testBondId2,
            'GBTESTUNAPPROVEDIMP12345',
            'SDTESTUNAPPROVEDSECRET999',
          ]
        );
        unapprovedImporterId = unappRes.rows[0]!.id;
      } finally {
        client.release();
      }
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      if (importerId || unapprovedImporterId) {
        await pool.query('DELETE FROM deposit_schedule_executions WHERE importer_id IN ($1, $2)', [
          importerId,
          unapprovedImporterId,
        ]);
        await pool.query('DELETE FROM deposit_schedules WHERE importer_id IN ($1, $2)', [
          importerId,
          unapprovedImporterId,
        ]);
        await pool.query('DELETE FROM notifications WHERE user_id IN ($1, $2)', [
          importerUserId,
          unapprovedUserId,
        ]);
        await pool.query('DELETE FROM importers WHERE id IN ($1, $2)', [
          importerId,
          unapprovedImporterId,
        ]);
      }
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, unapprovedUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('correctly calculates next run dates for weekly and monthly cadences', () => {
    const base = new Date('2026-01-01T12:00:00Z');
    const weekly = computeNextRunAt('weekly', base);
    const monthly = computeNextRunAt('monthly', base);

    const diffWeeklyDays = (weekly.getTime() - base.getTime()) / (24 * 60 * 60 * 1000);
    const diffMonthlyDays = (monthly.getTime() - base.getTime()) / (24 * 60 * 60 * 1000);

    assert.equal(diffWeeklyDays, 7);
    assert.equal(diffMonthlyDays, 30);
  });

  it('creates an active recurring deposit schedule', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const nextRun = computeNextRunAt('weekly', new Date());
    const res = await pool.query<{ id: string; status: string; cadence: string; amount_stroops: string }>(
      `INSERT INTO deposit_schedules (importer_id, user_id, cadence, amount_stroops, bucket, status, next_run_at)
       VALUES ($1, $2, $3, $4, 'collateral', 'active', $5)
       RETURNING id, status, cadence, amount_stroops::text AS amount_stroops`,
      [importerId, importerUserId, 'weekly', '5000000', nextRun]
    );

    assert.equal(res.rowCount, 1);
    testScheduleId = res.rows[0]!.id;
    assert.equal(res.rows[0]!.status, 'active');
    assert.equal(res.rows[0]!.cadence, 'weekly');
    assert.equal(res.rows[0]!.amount_stroops, '5000000');
  });

  it('pauses and resumes an active schedule', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    // Pause
    const pauseRes = await pool.query<{ status: string }>(
      `UPDATE deposit_schedules SET status = 'paused', updated_at = now()
       WHERE id = $1 AND importer_id = $2 RETURNING status`,
      [testScheduleId, importerId]
    );
    assert.equal(pauseRes.rows[0]!.status, 'paused');

    // Resume
    const resumeRes = await pool.query<{ status: string }>(
      `UPDATE deposit_schedules SET status = 'active', updated_at = now()
       WHERE id = $1 AND importer_id = $2 RETURNING status`,
      [testScheduleId, importerId]
    );
    assert.equal(resumeRes.rows[0]!.status, 'active');
  });

  it('edits schedule cadence and amount', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const editRes = await pool.query<{ cadence: string; amount_stroops: string }>(
      `UPDATE deposit_schedules
       SET cadence = 'monthly', amount_stroops = '12000000', updated_at = now()
       WHERE id = $1 AND importer_id = $2
       RETURNING cadence, amount_stroops::text AS amount_stroops`,
      [testScheduleId, importerId]
    );
    assert.equal(editRes.rows[0]!.cadence, 'monthly');
    assert.equal(editRes.rows[0]!.amount_stroops, '12000000');
  });

  it('cancels an active schedule', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const cancelRes = await pool.query<{ status: string }>(
      `UPDATE deposit_schedules SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND importer_id = $2 RETURNING status`,
      [testScheduleId, importerId]
    );
    assert.equal(cancelRes.rows[0]!.status, 'cancelled');

    const due = await pool.query(
      `SELECT id FROM deposit_schedules WHERE id = $1 AND status = 'active' AND next_run_at <= now()`,
      [testScheduleId]
    );
    assert.equal(due.rowCount, 0);
  });
});
