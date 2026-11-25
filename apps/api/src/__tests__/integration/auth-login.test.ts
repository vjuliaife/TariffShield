/**
 * Integration coverage for POST /auth/login security controls and session lifecycle:
 * - Lockout and P1 security incident logging after 10 failed login attempts (#572)
 * - Enforcement of concurrent MAX_SESSIONS by revoking the oldest active session (#573)
 * - Rejection of accounts with locked_until timestamp set in the future (#574)
 *
 * Run via: npm run test:integration --workspace=apps/api
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub('DATABASE_URL', 'postgres://test:test@localhost:5432/tariffshield_test');
stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { pool } = await import('../../db.js');
const { hashPassword, MAX_SESSIONS } = await import('../../auth.js');
const { authRouter } = await import('../../routes/auth.js');

const testTag = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
let serverUrl: string;

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
const server = createServer(app);

async function postLogin(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

async function getMe(token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}/auth/me`, {
    headers: {
      authorization: `Bearer ${token}`,
      connection: 'close',
    },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

async function createTestUser(
  emailPrefix: string,
  passwordPlain: string,
  role: 'importer' | 'surety_admin' = 'importer'
): Promise<{ id: string; email: string }> {
  const email = `${emailPrefix}-${testTag}@example.com`;
  const hash = await hashPassword(passwordPlain);
  const result = await pool.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, email`,
    [email, hash, role]
  );
  const user = result.rows[0]!;
  createdUserIds.push(user.id);
  createdEmails.push(user.email);
  return user;
}

describe('POST /auth/login integration suite (#572, #573, #574)', () => {
  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server.close();
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query(
        'DELETE FROM authentication_attempts WHERE email = ANY($1) OR user_id = ANY($2)',
        [createdEmails, createdUserIds]
      );
      await pool.query('DELETE FROM security_incidents WHERE affected_scope = ANY($1)', [createdEmails]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    await pool.end().catch(() => undefined);
  });

  describe('Issue #572: POST /auth/login Locks Out and Logs a Security Incident After 10 Failed Attempts', () => {
    it('returns 429 and logs a P1 security incident after 10 failed login attempts within 30 minutes, without locking unrelated accounts', async () => {
      const correctPassword = 'CorrectPassword123!';
      const targetUser = await createTestUser('lockout-target', correctPassword, 'importer');
      const unrelatedUser = await createTestUser('lockout-unrelated', correctPassword, 'importer');

      // 1. Submit 10 consecutive failed login attempts with wrong password
      for (let i = 1; i <= 10; i++) {
        const res = await postLogin({
          email: targetUser.email,
          password: `WrongPasswordAttempt${i}!`,
        });
        assert.equal(res.status, 401, `Attempt ${i} should return 401`);
        assert.deepEqual(res.body, { error: 'invalid credentials' });
      }

      // 2. Verify 10 failed authentication_attempts rows exist
      const failedAttemptsResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM authentication_attempts
         WHERE email = $1 AND success = FALSE`,
        [targetUser.email]
      );
      assert.equal(Number(failedAttemptsResult.rows[0]!.count), 10);

      // 3. 11th attempt (even with CORRECT password) must return 429
      const lockedAttemptWithCorrectPwd = await postLogin({
        email: targetUser.email,
        password: correctPassword,
      });
      assert.equal(lockedAttemptWithCorrectPwd.status, 429);
      assert.equal(
        lockedAttemptWithCorrectPwd.body?.error,
        'too many failed attempts, account locked for 30 minutes'
      );

      // 4. 12th attempt with WRONG password must still return 429
      const lockedAttemptWithWrongPwd = await postLogin({
        email: targetUser.email,
        password: 'AnotherWrongPassword!',
      });
      assert.equal(lockedAttemptWithWrongPwd.status, 429);

      // 5. Verify recordSecurityIncident was called with severity P1 referencing the account email
      const incidentResult = await pool.query<{
        severity: string;
        description: string;
        affected_scope: string;
      }>(
        `SELECT severity, description, affected_scope FROM security_incidents
         WHERE affected_scope = $1`,
        [targetUser.email]
      );
      assert.ok(incidentResult.rowCount! >= 1, 'Expected at least 1 security incident recorded');
      const incident = incidentResult.rows[0]!;
      assert.equal(incident.severity, 'P1');
      assert.equal(incident.affected_scope, targetUser.email);
      assert.ok(
        incident.description.includes('Brute-force attack detected on account'),
        `Expected description to mention brute-force attack: ${incident.description}`
      );

      // 6. Verify an unrelated, never-failed account is unaffected and can log in normally
      const unaffectedLogin = await postLogin({
        email: unrelatedUser.email,
        password: correctPassword,
      });
      assert.equal(unaffectedLogin.status, 200);
      assert.ok(unaffectedLogin.body.token, 'Expected JWT token for unaffected account');
      assert.equal(unaffectedLogin.body.user?.email, unrelatedUser.email);
    });
  });

  describe('Issue #573: POST /auth/login Enforces MAX_SESSIONS by Revoking the Oldest Session', () => {
    it('enforces MAX_SESSIONS for importer role (limit: 5) by revoking the oldest active session', async () => {
      const password = 'SessionLimitPassword123!';
      const importer = await createTestUser('sessions-importer', password, 'importer');
      const limit = MAX_SESSIONS.importer; // 5
      assert.equal(limit, 5, 'Importer session limit should be 5');

      const tokens: string[] = [];

      // Log in limit + 1 times (6 times)
      for (let i = 0; i < limit + 1; i++) {
        const res = await postLogin({ email: importer.email, password });
        assert.equal(res.status, 200, `Login iteration ${i + 1} must succeed`);
        assert.ok(res.body.token);
        tokens.push(res.body.token);
      }

      // Verify DB session counts: exactly 5 active sessions remain, 1 was revoked
      const activeSessions = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_sessions
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [importer.id]
      );
      assert.equal(
        Number(activeSessions.rows[0]!.count),
        limit,
        `Expected exactly ${limit} active sessions`
      );

      const revokedSessions = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_sessions
         WHERE user_id = $1 AND revoked_at IS NOT NULL`,
        [importer.id]
      );
      assert.equal(Number(revokedSessions.rows[0]!.count), 1, 'Expected 1 revoked session');

      // The first (oldest) token should return 401 on GET /auth/me
      const oldestTokenMe = await getMe(tokens[0]!);
      assert.equal(oldestTokenMe.status, 401);
      assert.equal(oldestTokenMe.body?.error, 'session expired or not found');

      // The newest token should continue to authenticate successfully
      const newestTokenMe = await getMe(tokens[tokens.length - 1]!);
      assert.equal(newestTokenMe.status, 200);
      assert.equal(newestTokenMe.body?.user?.id, importer.id);
      assert.equal(newestTokenMe.body?.user?.email, importer.email);
    });

    it('enforces MAX_SESSIONS for surety_admin role (limit: 3) by revoking the oldest active session', async () => {
      const password = 'SuretySessionPassword123!';
      const surety = await createTestUser('sessions-surety', password, 'surety_admin');
      const limit = MAX_SESSIONS.surety_admin; // 3
      assert.equal(limit, 3, 'Surety admin session limit should be 3');

      const tokens: string[] = [];

      // Log in limit + 1 times (4 times)
      for (let i = 0; i < limit + 1; i++) {
        const res = await postLogin({ email: surety.email, password });
        assert.equal(res.status, 200, `Surety login iteration ${i + 1} must succeed`);
        assert.ok(res.body.token);
        tokens.push(res.body.token);
      }

      // Verify DB session counts: exactly 3 active sessions remain, 1 was revoked
      const activeSessions = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_sessions
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [surety.id]
      );
      assert.equal(
        Number(activeSessions.rows[0]!.count),
        limit,
        `Expected exactly ${limit} active sessions for surety_admin`
      );

      const revokedSessions = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_sessions
         WHERE user_id = $1 AND revoked_at IS NOT NULL`,
        [surety.id]
      );
      assert.equal(Number(revokedSessions.rows[0]!.count), 1);

      // Oldest token returns 401
      const oldestTokenMe = await getMe(tokens[0]!);
      assert.equal(oldestTokenMe.status, 401);

      // Newest token authenticates successfully
      const newestTokenMe = await getMe(tokens[tokens.length - 1]!);
      assert.equal(newestTokenMe.status, 200);
      assert.equal(newestTokenMe.body?.user?.id, surety.id);
      assert.equal(newestTokenMe.body?.user?.role, 'surety_admin');
    });
  });

  describe('Issue #574: POST /auth/login Rejects locked_until Accounts with 403', () => {
    it('returns 403 when locked_until is in the future, records no successful auth attempt, and succeeds once locked_until is in the past', async () => {
      const password = 'LockoutTimestamp123!';
      const user = await createTestUser('locked-until-user', password, 'importer');

      // 1. Set locked_until in the future directly in Postgres
      await pool.query(
        `UPDATE users
         SET locked_until = now() + INTERVAL '30 minutes'
         WHERE id = $1`,
        [user.id]
      );

      // 2. Login attempt with correct password must return 403
      const lockedRes = await postLogin({
        email: user.email,
        password,
      });
      assert.equal(lockedRes.status, 403);
      assert.deepEqual(lockedRes.body, { error: 'account temporarily locked, try again later' });

      // 3. Verify no authentication_attempts success row is recorded while locked
      const successAttemptsWhileLocked = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM authentication_attempts
         WHERE email = $1 AND success = TRUE`,
        [user.email]
      );
      assert.equal(
        Number(successAttemptsWhileLocked.rows[0]!.count),
        0,
        'No successful auth attempts should be recorded while account is locked'
      );

      // 4. Update locked_until to a past timestamp
      await pool.query(
        `UPDATE users
         SET locked_until = now() - INTERVAL '5 minutes'
         WHERE id = $1`,
        [user.id]
      );

      // 5. The same login must now succeed with 200
      const unlockedRes = await postLogin({
        email: user.email,
        password,
      });
      assert.equal(unlockedRes.status, 200);
      assert.ok(unlockedRes.body.token);
      assert.equal(unlockedRes.body.user?.email, user.email);

      // 6. Verify an authentication_attempts success row is now recorded
      const successAttemptsAfterUnlock = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM authentication_attempts
         WHERE email = $1 AND success = TRUE`,
        [user.email]
      );
      assert.equal(
        Number(successAttemptsAfterUnlock.rows[0]!.count),
        1,
        'Exactly 1 successful auth attempt should be recorded after unlocking'
      );
    });
  });
});
