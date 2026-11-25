/**
 * Integration tests for /account/accept-tos (#644) and /account/tos-history (#646).
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../db.js';
import { env } from '../../config/env.js';
import { tosRouter } from '../../routes/tos.js';

const tag = randomUUID().slice(0, 8);
const versionOld = `v-test-old-${tag}`;
const versionNew = `v-test-new-${tag}`;

let dbAvailable = false;
let server: http.Server | undefined;
let baseUrl = '';

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

async function createTestUser(opts: {
  suffix: string;
  tosReacceptanceRequired?: boolean;
}): Promise<{ userId: string; token: string }> {
  const email = `tos-${opts.suffix}-${tag}@example.com`;
  const userRes = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, tos_reacceptance_required)
     VALUES ($1, $2, 'importer', $3)
     RETURNING id`,
    [email, 'integration-test-hash', opts.tosReacceptanceRequired ?? false]
  );
  const userId = userRes.rows[0]!.id;
  createdUserIds.push(userId);

  const sessionRes = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, expires_at)
     VALUES ($1, now() + interval '1 hour')
     RETURNING id`,
    [userId]
  );
  const sessionId = sessionRes.rows[0]!.id;
  createdSessionIds.push(sessionId);

  const token = jwt.sign(
    { id: userId, email, role: 'importer', sessionId },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  return { userId, token };
}

describe('ToS routes integration (#644, #646)', () => {
  before(async () => {
    try {
      await pool.query(
        `INSERT INTO tos_versions (version_id, effective_date, change_summary, requires_reacceptance)
         VALUES ($1, '2026-01-01', 'Initial test terms', FALSE),
                ($2, '2026-06-01', 'Updated liability clause', TRUE)
         ON CONFLICT (version_id) DO NOTHING`,
        [versionOld, versionNew]
      );
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/account', tosRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (dbAvailable) {
      if (createdUserIds.length > 0) {
        await pool.query('DELETE FROM tos_acceptances WHERE user_id = ANY($1::uuid[])', [
          createdUserIds,
        ]);
        await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
      }
      await pool.query('DELETE FROM tos_versions WHERE version_id IN ($1, $2)', [
        versionOld,
        versionNew,
      ]);
    }
    await pool.end().catch(() => undefined);
  });

  it('POST /account/accept-tos clears tos_reacceptance_required and records re-acceptance (#644)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const { userId, token } = await createTestUser({
      suffix: 'reaccept',
      tosReacceptanceRequired: true,
    });

    const userAgent = 'TariffShield-Integration-Test/1.0';
    const forwardedIp = '203.0.113.42';

    const res = await fetch(`${baseUrl}/account/accept-tos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': userAgent,
        'x-forwarded-for': forwardedIp,
      },
      body: JSON.stringify({ versionId: versionNew }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { accepted: boolean; versionId: string };
    assert.equal(body.accepted, true);
    assert.equal(body.versionId, versionNew);

    const userRow = await pool.query<{ tos_reacceptance_required: boolean }>(
      'SELECT tos_reacceptance_required FROM users WHERE id = $1',
      [userId]
    );
    assert.equal(userRow.rows[0]?.tos_reacceptance_required, false);

    const acceptanceRows = await pool.query<{
      tos_version: string;
      acceptance_method: string;
      ip_address: string | null;
      user_agent: string | null;
    }>(
      `SELECT tos_version, acceptance_method, ip_address, user_agent
       FROM tos_acceptances
       WHERE user_id = $1`,
      [userId]
    );
    assert.equal(acceptanceRows.rowCount, 1);
    assert.equal(acceptanceRows.rows[0]!.tos_version, versionNew);
    assert.equal(acceptanceRows.rows[0]!.acceptance_method, 're-acceptance');
    assert.equal(acceptanceRows.rows[0]!.ip_address, forwardedIp);
    assert.equal(acceptanceRows.rows[0]!.user_agent, userAgent);

    const historyRes = await fetch(`${baseUrl}/account/tos-history`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(historyRes.status, 200);
    const historyBody = (await historyRes.json()) as {
      acceptances: Array<{
        tos_version: string;
        acceptance_method: string;
        ip_address: string | null;
      }>;
    };
    assert.equal(historyBody.acceptances.length, 1);
    assert.equal(historyBody.acceptances[0]!.tos_version, versionNew);
    assert.equal(historyBody.acceptances[0]!.acceptance_method, 're-acceptance');
    assert.equal(historyBody.acceptances[0]!.ip_address, forwardedIp);
  });

  it('GET /account/tos-history orders acceptances accepted_at DESC with version metadata (#646)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const { userId: userA, token: tokenA } = await createTestUser({ suffix: 'history-a' });
    const { userId: userB, token: tokenEmpty } = await createTestUser({ suffix: 'history-empty' });
    const { userId: userOther } = await createTestUser({ suffix: 'history-other' });

    await pool.query(
      `INSERT INTO tos_acceptances (user_id, tos_version, accepted_at, acceptance_method)
       VALUES ($1, $2, '2026-02-01T10:00:00Z', 'signup'),
              ($1, $3, '2026-06-15T12:00:00Z', 're-acceptance'),
              ($4, $2, '2026-07-01T00:00:00Z', 'signup')`,
      [userA, versionOld, versionNew, userOther]
    );

    const resA = await fetch(`${baseUrl}/account/tos-history`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as {
      acceptances: Array<{
        tos_version: string;
        accepted_at: string;
        acceptance_method: string;
        effective_date: string;
        change_summary: string;
      }>;
    };
    assert.equal(bodyA.acceptances.length, 2);
    assert.equal(bodyA.acceptances[0]!.tos_version, versionNew);
    assert.equal(bodyA.acceptances[0]!.acceptance_method, 're-acceptance');
    assert.equal(bodyA.acceptances[0]!.change_summary, 'Updated liability clause');
    assert.ok(bodyA.acceptances[0]!.effective_date);
    assert.equal(bodyA.acceptances[1]!.tos_version, versionOld);
    assert.equal(bodyA.acceptances[1]!.acceptance_method, 'signup');
    assert.equal(bodyA.acceptances[1]!.change_summary, 'Initial test terms');
    assert.ok(
      new Date(bodyA.acceptances[0]!.accepted_at).getTime() >
        new Date(bodyA.acceptances[1]!.accepted_at).getTime()
    );

    const resEmpty = await fetch(`${baseUrl}/account/tos-history`, {
      headers: { authorization: `Bearer ${tokenEmpty}` },
    });
    assert.equal(resEmpty.status, 200);
    const bodyEmpty = (await resEmpty.json()) as { acceptances: unknown[] };
    assert.deepEqual(bodyEmpty.acceptances, []);
    assert.ok(userB);
  });
});
