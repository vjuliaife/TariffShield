/**
 * Integration tests for POST /importers/:id/deposit KYC gate (#593).
 *
 * Covers all acceptance criteria from issue #593:
 *   1. kyc_status 'pending'  → 403 with error message and current kycStatus
 *   2. kyc_status 'rejected' → 403 with error message and current kycStatus
 *   3. kyc_status 'approved' but HIGH-risk wallet → 403 from AML screening
 *   4. kyc_status 'approved' and LOW-risk wallet  → 202 with jobId
 *
 * Run via: npm run test:integration --workspace=apps/api
 *
 * Prerequisites:
 *   - DATABASE_URL must point to a migrated test database.
 *   - REDIS_URL (optional): the 202 happy-path sub-test is skipped when Redis
 *     is unreachable. In CI the api-integration.yml workflow starts a Redis
 *     service so all four tests run.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Env stubs (must precede all dynamic imports that read process.env) ─────────
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

// ── Dynamic imports (env stubs must be set first) ──────────────────────────────
const { pool, createSession } = await import('../../db.js');
const { signToken } = await import('../../auth.js');
const { importersRouter } = await import('../../routes/importers.js');

// ── Test-run-scoped identifiers ────────────────────────────────────────────────
const testTag = randomUUID().slice(0, 8);

// Addresses crafted for the AML mock in src/services/aml-screening.ts:
//   determineMockRiskScore: HIGH if starts-with-'G' AND contains 'HIGH', else LOW.
// Using testTag keeps each run's addresses unique so cleanup is precise.
const LOW_RISK_ADDR = `GDEPOSIT593LOW${testTag.toUpperCase()}`.padEnd(56, '0');
const HIGH_RISK_ADDR = `GHIGH593DEPOSIT${testTag.toUpperCase()}`.padEnd(56, '0');

// A dummy encrypted secret — the deposit route passes it straight to the
// queue worker; for the purpose of route-layer testing it can be any string.
const DUMMY_SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';

// ── Express app wired with the real importersRouter ────────────────────────────
const app = express();
app.use(express.json());
app.use('/importers', importersRouter);
const server = createServer(app);

// ── State shared across hooks and tests ────────────────────────────────────────
let serverUrl: string;
let dbAvailable = false;
let redisAvailable = false;
let importerUserId: string;
let importerId: string;
let importerToken: string;
const userIds: string[] = [];
const importerIds: string[] = [];
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

/** Standard deposit body used by every sub-test (bucket + amount). */
const DEPOSIT_BODY = { amountStroops: '10000000', bucket: 'collateral' };

async function postDeposit(id: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}/importers/${id}/deposit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify(DEPOSIT_BODY),
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('POST /importers/:id/deposit — KYC gate (#593)', () => {
  before(async () => {
    // ── 1. Seed DB ─────────────────────────────────────────────────────────────
    try {
      const userEmail = `deposit-kyc-593-${testTag}@example.com`;

      const userRow = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer')
         RETURNING id`,
        [userEmail, 'test-hash-not-real']
      );
      importerUserId = userRow.rows[0]!.id;
      userIds.push(importerUserId);

      // kyc_status starts as 'pending'; tests UPDATE it as they progress.
      const impRow = await pool.query<{ id: string }>(
        `INSERT INTO importers
           (user_id, legal_name, bond_id, stellar_address,
            stellar_secret_encrypted, kyc_status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [
          importerUserId,
          `KYC Gate Test Corp ${testTag}`,
          testBondId,
          LOW_RISK_ADDR,
          DUMMY_SECRET,
        ]
      );
      importerId = impRow.rows[0]!.id;
      importerIds.push(importerId);

      const sessionId = await createSession(importerUserId);
      importerToken = signToken({ id: importerUserId, email: userEmail, role: 'importer', sessionId });

      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return; // skip server startup if DB is unreachable
    }

    // ── 2. Check Redis availability (required only for the 202 happy-path) ─────
    try {
      const { default: Redis } = await import('ioredis');
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
      const probe = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1500,
        lazyConnect: true,
      });
      await probe.connect();
      redisAvailable = (await probe.ping()) === 'PONG';
      await probe.quit().catch(() => undefined);
    } catch {
      redisAvailable = false;
    }

    // ── 3. Start HTTP server ───────────────────────────────────────────────────
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    // Clean up in dependency order: audit_log → aml_screenings → importers → users
    await pool
      .query('DELETE FROM audit_log WHERE actor_user_id = ANY($1::uuid[])', [userIds])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM aml_screenings WHERE wallet_address = ANY($1::text[])', [
        [LOW_RISK_ADDR, HIGH_RISK_ADDR],
      ])
      .catch(() => undefined);
    if (importerIds.length) {
      await pool
        .query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [importerIds])
        .catch(() => undefined);
    }
    if (userIds.length) {
      await pool
        .query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
        .catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  });

  // ── Test 1: pending → 403 ────────────────────────────────────────────────────
  it('returns 403 with KYC error and kycStatus when kyc_status is pending', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const res = await postDeposit(importerId, importerToken);
    const body = (await res.json()) as { error: string; kycStatus: string };

    assert.equal(res.status, 403, 'pending importer should be blocked with 403');
    assert.equal(
      body.error,
      'KYC approval required before collateral deposits',
      'error message must match the route implementation'
    );
    assert.equal(body.kycStatus, 'pending', 'response must echo the current kycStatus');
  });

  // ── Test 2: rejected → 403 ───────────────────────────────────────────────────
  it('returns 403 with KYC error and kycStatus when kyc_status is rejected', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    await pool.query(`UPDATE importers SET kyc_status = 'rejected' WHERE id = $1`, [importerId]);

    const res = await postDeposit(importerId, importerToken);
    const body = (await res.json()) as { error: string; kycStatus: string };

    assert.equal(res.status, 403, 'rejected importer should be blocked with 403');
    assert.equal(
      body.error,
      'KYC approval required before collateral deposits',
      'error message must match the route implementation'
    );
    assert.equal(body.kycStatus, 'rejected', 'response must echo the current kycStatus');
  });

  // ── Test 3: approved + HIGH-risk wallet → AML 403 ────────────────────────────
  // Verifies that AML screening is still enforced after the KYC gate passes.
  it('still enforces AML screening after KYC approval (HIGH-risk wallet → 403)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    // Approve KYC but switch to a wallet address the AML mock flags as HIGH risk.
    await pool.query(
      `UPDATE importers SET kyc_status = 'approved', stellar_address = $1 WHERE id = $2`,
      [HIGH_RISK_ADDR, importerId]
    );

    const res = await postDeposit(importerId, importerToken);
    const body = (await res.json()) as { error: string };

    assert.equal(res.status, 403, 'HIGH-risk wallet should be blocked with 403 by AML');
    assert.equal(
      body.error,
      'Transaction blocked pending AML review',
      'AML block message must match the route implementation'
    );
  });

  // ── Test 4: approved + LOW-risk wallet → 202 ─────────────────────────────────
  // The full happy path: KYC gate clears, AML clears, job is enqueued.
  // Requires Redis (BullMQ queue); skipped automatically when Redis is absent.
  it('returns 202 with jobId when kyc_status is approved and AML screening passes', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');
    if (!redisAvailable) {
      return t.skip(
        'Redis not reachable — skipping 202 happy-path check ' +
          '(CI api-integration.yml starts a Redis service so this sub-test runs in CI)'
      );
    }

    // Reset the importer to approved KYC with the LOW-risk address.
    await pool.query(
      `UPDATE importers SET kyc_status = 'approved', stellar_address = $1 WHERE id = $2`,
      [LOW_RISK_ADDR, importerId]
    );

    const res = await postDeposit(importerId, importerToken);
    const body = (await res.json()) as { jobId: string; statusUrl: string };

    assert.equal(res.status, 202, 'approved importer with LOW-risk wallet should get 202');
    assert.ok(body.jobId, 'response body must include a jobId');
    assert.ok(
      typeof body.statusUrl === 'string' && body.statusUrl.includes(importerId),
      'statusUrl must reference the importer id'
    );
  });
});
