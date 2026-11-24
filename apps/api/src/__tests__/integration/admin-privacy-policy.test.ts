/**
 * Integration coverage for POST /admin/privacy-policy/publish (#598).
 *
 * Run via: npm run test:integration --workspace=apps/api
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

const { pool, createSession } = await import('../../db.js');
const { signToken } = await import('../../auth.js');
const { adminRouter } = await import('../../routes/admin.js');

interface PrivacyPolicyVersionRow {
  id: string;
  version_id: string;
  effective_date: string;
  requires_reacceptance: boolean;
  published_at: string;
}

interface PublishResponse {
  version?: PrivacyPolicyVersionRow;
  error?: string;
  target?: string;
  details?: Array<{ path: string[]; message: string }>;
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const publishedVersionIds: string[] = [];

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const server = createServer(app);

let serverUrl: string;
let suretyToken: string;
let importerToken: string;
let suretyUserId: string;
let importerUserId: string;

async function publishPolicy(
  body: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    connection: 'close',
  };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(`${serverUrl}/admin/privacy-policy/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /admin/privacy-policy/publish integration (#598)', () => {
  before(async () => {
    // 1. Create surety_admin user and session
    const surety = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role, privacy_reacceptance_required)
       VALUES ($1, $2, 'surety_admin', FALSE)
       RETURNING id, email`,
      [`surety-publish-${testTag}@example.com`, 'test-hash-not-real']
    );
    const suretyUser = surety.rows[0]!;
    suretyUserId = suretyUser.id;
    userIds.push(suretyUserId);

    const suretySession = await createSession(suretyUserId);
    suretyToken = signToken({
      id: suretyUserId,
      email: suretyUser.email,
      role: 'surety_admin',
      sessionId: suretySession,
    });

    // 2. Create importer user and session
    const importer = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role, privacy_reacceptance_required)
       VALUES ($1, $2, 'importer', FALSE)
       RETURNING id, email`,
      [`importer-publish-${testTag}@example.com`, 'test-hash-not-real']
    );
    const importerUser = importer.rows[0]!;
    importerUserId = importerUser.id;
    userIds.push(importerUserId);

    const importerSession = await createSession(importerUserId);
    importerToken = signToken({
      id: importerUserId,
      email: importerUser.email,
      role: 'importer',
      sessionId: importerSession,
    });

    // 3. Start test Express server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    // Delete policy versions before users due to published_by foreign key
    if (publishedVersionIds.length) {
      await pool.query(
        'DELETE FROM privacy_policy_versions WHERE version_id = ANY($1::text[])',
        [publishedVersionIds]
      );
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  it('changeSummary shorter than 10 characters returns 400 validation error', async () => {
    const invalidPayload = {
      versionId: `v-short-${testTag}`,
      effectiveDate: '2026-12-01',
      changeSummary: 'Too short', // 9 characters (< 10)
      requiresReacceptance: false,
    };

    const response = await publishPolicy(invalidPayload, suretyToken);
    assert.strictEqual(response.status, 400, 'should reject short changeSummary with 400');
    const body = (await response.json()) as PublishResponse;
    assert.strictEqual(body.error, 'invalid input');
    assert.strictEqual(body.target, 'body');
    assert.ok(
      body.details?.some((d) => d.path.includes('changeSummary')),
      'details should indicate error on changeSummary'
    );
  });

  it('Publishing with requiresReacceptance false does not modify any user flag and returns 201', async () => {
    // Ensure both test users start with privacy_reacceptance_required = FALSE
    await pool.query(
      'UPDATE users SET privacy_reacceptance_required = FALSE WHERE id = ANY($1::uuid[])',
      [userIds]
    );

    const versionId = `v-noreaccept-${testTag}`;
    publishedVersionIds.push(versionId);

    const payload = {
      versionId,
      effectiveDate: '2026-12-01',
      changeSummary: 'Routine clarifications and minor wording updates',
      policyText: 'Standard updated privacy policy content without re-acceptance.',
      requiresReacceptance: false,
    };

    const response = await publishPolicy(payload, suretyToken);
    assert.strictEqual(response.status, 201, 'publishing should return 201 Created');
    const body = (await response.json()) as PublishResponse;

    // Verify 201 response includes the new privacy_policy_versions row
    assert.ok(body.version, '201 response must contain version object');
    assert.strictEqual(body.version.version_id, versionId);
    assert.strictEqual(body.version.requires_reacceptance, false);
    assert.ok(body.version.id, 'version must include id');
    assert.ok(body.version.effective_date, 'version must include effective_date');
    assert.ok(body.version.published_at, 'version must include published_at');

    // Verify neither user's flag was modified in the database
    const userCheck = await pool.query<{ id: string; privacy_reacceptance_required: boolean }>(
      'SELECT id, privacy_reacceptance_required FROM users WHERE id = ANY($1::uuid[])',
      [userIds]
    );

    for (const row of userCheck.rows) {
      assert.strictEqual(
        row.privacy_reacceptance_required,
        false,
        `user ${row.id} flag should remain FALSE when requiresReacceptance is false`
      );
    }
  });

  it('Publishing with requiresReacceptance true sets privacy_reacceptance_required TRUE on all importer/surety_admin users', async () => {
    // Ensure test users start with privacy_reacceptance_required = FALSE
    await pool.query(
      'UPDATE users SET privacy_reacceptance_required = FALSE WHERE id = ANY($1::uuid[])',
      [userIds]
    );

    const versionId = `v-reaccept-${testTag}`;
    publishedVersionIds.push(versionId);

    const payload = {
      versionId,
      effectiveDate: '2026-12-15',
      changeSummary: 'Major update requiring all active participants to re-accept',
      policyText: 'Updated terms requiring re-acceptance by all users.',
      requiresReacceptance: true,
    };

    const response = await publishPolicy(payload, suretyToken);
    assert.strictEqual(response.status, 201, 'publishing should return 201 Created');
    const body = (await response.json()) as PublishResponse;

    // Verify 201 response contains the version row with requires_reacceptance = true
    assert.ok(body.version, 'response must include version object');
    assert.strictEqual(body.version.version_id, versionId);
    assert.strictEqual(body.version.requires_reacceptance, true);

    // Verify all importer and surety_admin users have privacy_reacceptance_required = TRUE
    const userCheck = await pool.query<{
      id: string;
      role: string;
      privacy_reacceptance_required: boolean;
    }>(
      `SELECT id, role, privacy_reacceptance_required FROM users
       WHERE role IN ('importer', 'surety_admin')`
    );

    assert.ok(userCheck.rows.length >= 2, 'should check at least the seeded users');
    for (const row of userCheck.rows) {
      assert.strictEqual(
        row.privacy_reacceptance_required,
        true,
        `user ${row.id} with role ${row.role} must have privacy_reacceptance_required set to TRUE`
      );
    }
  });

  it('rejects publication by an importer token with 403', async () => {
    const payload = {
      versionId: `v-unauth-${testTag}`,
      effectiveDate: '2026-12-20',
      changeSummary: 'Attempted publish by unprivileged user',
      requiresReacceptance: false,
    };

    const response = await publishPolicy(payload, importerToken);
    assert.strictEqual(response.status, 403, 'importer should be rejected with 403');
    const body = (await response.json()) as PublishResponse;
    assert.strictEqual(body.error, 'forbidden');
  });

  it('rejects publication without authentication token with 401', async () => {
    const payload = {
      versionId: `v-anon-${testTag}`,
      effectiveDate: '2026-12-20',
      changeSummary: 'Attempted publish anonymously',
      requiresReacceptance: false,
    };

    const response = await publishPolicy(payload);
    assert.strictEqual(response.status, 401, 'missing token should return 401');
    const body = (await response.json()) as PublishResponse;
    assert.strictEqual(body.error, 'missing bearer token');
  });
});
