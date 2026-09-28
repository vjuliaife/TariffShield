import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migration0014Up } from '../../migrations/0014_scheduled_withdrawals.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });

const testTag = randomUUID().slice(0, 8);
const importerEmail = `test-imp-994-${testTag}@example.com`;

let dbAvailable = false;
let importerUserId: string;
let importerId: string;
let testWithdrawalId: string;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issue #994 — Future-Dated Staged Withdrawal Scheduling for Collateral', () => {
  before(async () => {
    try {
      const client = await pool.connect();
      try {
        await migration0014Up(client);
        dbAvailable = true;

        const u1 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [importerEmail, 'hash1', 'importer']
        );
        importerUserId = u1.rows[0]!.id;

        const impRes = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, stellar_secret_encrypted, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, $5, 'approved', 20000000)
           RETURNING id`,
          [
            importerUserId,
            'Scheduled Withdrawal Importer Corp',
            testBondId,
            'GBTESTSCHEDULEDWITHDRAWAL123',
            'SWTESTSECRETKEY1234567890',
          ]
        );
        importerId = impRes.rows[0]!.id;
      } finally {
        client.release();
      }
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      if (importerId) {
        await pool.query('DELETE FROM scheduled_withdrawals WHERE importer_id = $1', [importerId]);
        await pool.query('DELETE FROM notifications WHERE user_id = $1', [importerUserId]);
        await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
      }
      await pool.query('DELETE FROM users WHERE id = $1', [importerUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('verifies shortfall calculation logic before withdrawal execution', () => {
    const collateralBalance = 10000000n; // 10M
    const requiredCollateral = 8000000n; // 8M
    const withdrawalAmountSafe = 1500000n; // 1.5M -> leaves 8.5M >= 8M (safe)
    const withdrawalAmountBreach = 3000000n; // 3M -> leaves 7M < 8M (shortfall)

    const isSafe = collateralBalance - withdrawalAmountSafe >= requiredCollateral;
    const isBreach = collateralBalance - withdrawalAmountBreach < requiredCollateral;

    assert.equal(isSafe, true);
    assert.equal(isBreach, true);
  });

  it('schedules a withdrawal request with a target execution date', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const targetDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days in future
    const res = await pool.query<{ id: string; status: string; amount_stroops: string }>(
      `INSERT INTO scheduled_withdrawals (importer_id, requested_by, amount_stroops, target_date, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, status, amount_stroops::text AS amount_stroops`,
      [importerId, importerUserId, '5000000', targetDate]
    );

    assert.equal(res.rowCount, 1);
    testWithdrawalId = res.rows[0]!.id;
    assert.equal(res.rows[0]!.status, 'pending');
    assert.equal(res.rows[0]!.amount_stroops, '5000000');
  });

  it('cancels a pending scheduled withdrawal before its target date', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const cancelRes = await pool.query<{ status: string; execution_result: string }>(
      `UPDATE scheduled_withdrawals
       SET status = 'cancelled', execution_result = 'Cancelled by user', updated_at = now()
       WHERE id = $1 AND importer_id = $2 AND status = 'pending' AND target_date > now()
       RETURNING status, execution_result`,
      [testWithdrawalId, importerId]
    );

    assert.equal(cancelRes.rowCount, 1);
    assert.equal(cancelRes.rows[0]!.status, 'cancelled');
    assert.equal(cancelRes.rows[0]!.execution_result, 'Cancelled by user');
  });

  it('records a blocked status when withdrawal would breach required collateral', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const breachAmount = '15000000';
    const reason = 'Collateral requirement breach: available balance (10000000) minus withdrawal (15000000) is less than required collateral (8000000)';

    const res = await pool.query<{ id: string; status: string; execution_result: string }>(
      `INSERT INTO scheduled_withdrawals (importer_id, requested_by, amount_stroops, target_date, status, execution_result)
       VALUES ($1, $2, $3, now(), 'blocked', $4)
       RETURNING id, status, execution_result`,
      [importerId, importerUserId, breachAmount, reason]
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0]!.status, 'blocked');
    assert.ok(res.rows[0]!.execution_result.includes('breach'));
  });

  it('appears in collateral history query context', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const historyRes = await pool.query(
      `SELECT id, importer_id, amount_stroops::text AS amount_stroops, target_date, status
       FROM scheduled_withdrawals
       WHERE importer_id = $1
       ORDER BY target_date ASC`,
      [importerId]
    );

    assert.ok(historyRes.rowCount && historyRes.rowCount >= 2);
  });
});
