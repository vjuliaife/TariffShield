/**
 * Integration coverage for POST /auth/signup transactional guarantees:
 * - Records ToS and privacy policy acceptance transactionally (#570)
 * - Resolves latest privacy policy version when omitted (#570)
 * - Records pending license verification for surety_admin role (#570)
 * - Rejects duplicate email with HTTP 409 and avoids partial writes (#571)
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
const { authRouter } = await import('../../routes/auth.js');

const testTag = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const customPolicyVersions: string[] = [];
let serverUrl: string;

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
const server = createServer(app);

async function postSignup(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}/auth/signup`, {
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

describe('POST /auth/signup integration suite (#570, #571)', () => {
  before(async () => {
    // Ensure default ToS and privacy policy versions exist for lookup
    await pool.query(
      `INSERT INTO tos_versions (version_id, effective_date, change_summary)
       VALUES ('v1.0.0', CURRENT_DATE, 'Initial Terms of Service')
       ON CONFLICT (version_id) DO NOTHING`
    );

    await pool.query(
      `INSERT INTO privacy_policy_versions (version_id, effective_date, change_summary)
       VALUES ('v1.0.0', CURRENT_DATE, 'Initial Privacy Policy')
       ON CONFLICT (version_id) DO NOTHING`
    );

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
      await pool.query('DELETE FROM surety_license_verifications WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM tos_acceptances WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM privacy_policy_acceptances WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (customPolicyVersions.length > 0) {
      await pool.query('DELETE FROM privacy_policy_versions WHERE version_id = ANY($1)', [customPolicyVersions]);
    }
    await pool.end().catch(() => undefined);
  });

  describe('Issue #570: POST /auth/signup Records ToS and Privacy Policy Acceptance Transactionally', () => {
    it('creates importer user, records ToS acceptance with acceptance_method = signup, and resolves latest privacy policy version', async () => {
      const email = `signup-importer-${testTag}@example.com`;
      const res = await postSignup({
        email,
        password: 'Password123!',
        role: 'importer',
        accept_tos: true,
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.token, 'Expected JWT token in response');
      assert.ok(res.body.user?.id, 'Expected user id in response');
      assert.equal(res.body.user.email, email);
      assert.equal(res.body.user.role, 'importer');

      const userId = res.body.user.id;
      createdUserIds.push(userId);

      // Verify ToS acceptance record
      const tosAcceptances = await pool.query<{
        tos_version: string;
        acceptance_method: string;
      }>(
        'SELECT tos_version, acceptance_method FROM tos_acceptances WHERE user_id = $1',
        [userId]
      );
      assert.equal(tosAcceptances.rowCount, 1, 'Expected exactly 1 tos_acceptances row');
      assert.equal(tosAcceptances.rows[0]!.acceptance_method, 'signup');
      assert.ok(tosAcceptances.rows[0]!.tos_version, 'Expected non-empty tos_version');

      // Verify latest privacy policy version was resolved and recorded
      const latestPolicy = await pool.query<{ version_id: string }>(
        'SELECT version_id FROM privacy_policy_versions ORDER BY effective_date DESC LIMIT 1'
      );
      const expectedPolicyVersion = latestPolicy.rows[0]!.version_id;

      const privacyAcceptances = await pool.query<{
        policy_version_id: string;
        acceptance_channel: string;
      }>(
        'SELECT policy_version_id, acceptance_channel FROM privacy_policy_acceptances WHERE user_id = $1',
        [userId]
      );
      assert.equal(privacyAcceptances.rowCount, 1, 'Expected exactly 1 privacy_policy_acceptances row');
      assert.equal(privacyAcceptances.rows[0]!.policy_version_id, expectedPolicyVersion);
      assert.equal(privacyAcceptances.rows[0]!.acceptance_channel, 'signup');

      // Importer role should NOT create a surety_license_verifications record
      const licenseVerifications = await pool.query(
        'SELECT id FROM surety_license_verifications WHERE user_id = $1',
        [userId]
      );
      assert.equal(licenseVerifications.rowCount, 0, 'Importer must not have surety_license_verifications');
    });

    it('creates surety_admin user and records pending surety_license_verifications row along with ToS and privacy acceptances', async () => {
      const email = `signup-surety-${testTag}@example.com`;
      const res = await postSignup({
        email,
        password: 'Password123!',
        role: 'surety_admin',
        accept_tos: true,
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.user?.id);
      assert.equal(res.body.user.role, 'surety_admin');

      const userId = res.body.user.id;
      createdUserIds.push(userId);

      // Verify pending license verification was created
      const licenseVerifications = await pool.query<{
        status: string;
      }>(
        'SELECT status FROM surety_license_verifications WHERE user_id = $1',
        [userId]
      );
      assert.equal(licenseVerifications.rowCount, 1, 'Expected 1 surety_license_verifications row');
      assert.equal(licenseVerifications.rows[0]!.status, 'pending');

      // Verify ToS acceptance was recorded
      const tosAcceptances = await pool.query<{ acceptance_method: string }>(
        'SELECT acceptance_method FROM tos_acceptances WHERE user_id = $1',
        [userId]
      );
      assert.equal(tosAcceptances.rowCount, 1);
      assert.equal(tosAcceptances.rows[0]!.acceptance_method, 'signup');

      // Verify privacy policy acceptance was recorded
      const privacyAcceptances = await pool.query<{ acceptance_channel: string }>(
        'SELECT acceptance_channel FROM privacy_policy_acceptances WHERE user_id = $1',
        [userId]
      );
      assert.equal(privacyAcceptances.rowCount, 1);
      assert.equal(privacyAcceptances.rows[0]!.acceptance_channel, 'signup');
    });

    it('records explicitly provided privacyPolicyVersionId when supplied at signup', async () => {
      const customVersion = `v2.0.0-custom-${testTag}`;
      await pool.query(
        `INSERT INTO privacy_policy_versions (version_id, effective_date, change_summary)
         VALUES ($1, CURRENT_DATE, 'Custom Version Test')`,
        [customVersion]
      );
      customPolicyVersions.push(customVersion);

      const email = `signup-custom-policy-${testTag}@example.com`;
      const res = await postSignup({
        email,
        password: 'Password123!',
        role: 'importer',
        accept_tos: true,
        privacyPolicyVersionId: customVersion,
      });

      assert.equal(res.status, 200);
      const userId = res.body.user.id;
      createdUserIds.push(userId);

      const privacyAcceptances = await pool.query<{ policy_version_id: string }>(
        'SELECT policy_version_id FROM privacy_policy_acceptances WHERE user_id = $1',
        [userId]
      );
      assert.equal(privacyAcceptances.rowCount, 1);
      assert.equal(privacyAcceptances.rows[0]!.policy_version_id, customVersion);
    });
  });

  describe('Issue #571: POST /auth/signup Duplicate Email Returns 409 Without Partial Writes', () => {
    it('returns 409 { error: "email already registered" } and prevents partial writes on duplicate email', async () => {
      const email = `signup-duplicate-${testTag}@example.com`;

      // 1. First signup succeeds
      const firstRes = await postSignup({
        email,
        password: 'InitialPassword123!',
        role: 'importer',
        accept_tos: true,
      });

      assert.equal(firstRes.status, 200);
      assert.ok(firstRes.body.user?.id);
      const originalUserId = firstRes.body.user.id;
      createdUserIds.push(originalUserId);

      // Verify initial records
      const initialUsers = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      assert.equal(initialUsers.rowCount, 1);

      const initialTos = await pool.query('SELECT id FROM tos_acceptances WHERE user_id = $1', [originalUserId]);
      assert.equal(initialTos.rowCount, 1);

      const initialPrivacy = await pool.query('SELECT id FROM privacy_policy_acceptances WHERE user_id = $1', [originalUserId]);
      assert.equal(initialPrivacy.rowCount, 1);

      // 2. Second signup with identical email fails with 409
      const secondRes = await postSignup({
        email,
        password: 'DifferentPassword456!',
        role: 'importer',
        accept_tos: true,
      });

      assert.equal(secondRes.status, 409);
      assert.deepEqual(secondRes.body, { error: 'email already registered' });

      // 3. Verify database state remains intact without partial writes or extra records
      const usersAfter = await pool.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      assert.equal(usersAfter.rowCount, 1, 'Users table must still contain exactly 1 row for that email');
      assert.equal(usersAfter.rows[0]!.id, originalUserId);

      const tosAfter = await pool.query(
        'SELECT id FROM tos_acceptances WHERE user_id = $1',
        [originalUserId]
      );
      assert.equal(tosAfter.rowCount, 1, 'tos_acceptances must not have duplicate or partial rows');

      const privacyAfter = await pool.query(
        'SELECT id FROM privacy_policy_acceptances WHERE user_id = $1',
        [originalUserId]
      );
      assert.equal(privacyAfter.rowCount, 1, 'privacy_policy_acceptances must not have duplicate or partial rows');

      // Verify no orphaned records exist referencing nonexistent users
      const orphanedTos = await pool.query(
        'SELECT id FROM tos_acceptances WHERE user_id NOT IN (SELECT id FROM users)'
      );
      assert.equal(orphanedTos.rowCount, 0, 'No orphaned tos_acceptances rows allowed');

      const orphanedPrivacy = await pool.query(
        'SELECT id FROM privacy_policy_acceptances WHERE user_id NOT IN (SELECT id FROM users)'
      );
      assert.equal(orphanedPrivacy.rowCount, 0, 'No orphaned privacy_policy_acceptances rows allowed');
    });

    it('returns 409 when duplicate email is submitted with differing letter casing', async () => {
      const baseEmail = `signup-case-${testTag}@example.com`;
      const firstRes = await postSignup({
        email: baseEmail.toLowerCase(),
        password: 'Password123!',
        role: 'importer',
        accept_tos: true,
      });

      assert.equal(firstRes.status, 200);
      createdUserIds.push(firstRes.body.user.id);

      // Attempt signup with UPPERCASE version of the same email
      const uppercaseRes = await postSignup({
        email: baseEmail.toUpperCase(),
        password: 'Password123!',
        role: 'importer',
        accept_tos: true,
      });

      assert.equal(uppercaseRes.status, 409);
      assert.deepEqual(uppercaseRes.body, { error: 'email already registered' });

      const userCount = await pool.query(
        'SELECT COUNT(*) AS count FROM users WHERE email = $1',
        [baseEmail.toLowerCase()]
      );
      assert.equal(Number(userCount.rows[0]!.count), 1);
    });
  });
});
