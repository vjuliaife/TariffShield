/**
 * Integration tests for GET /importers/:id/tx-status/:jobId (#595).
 *
 * Verifies that the tx-status route correctly reflects BullMQ job state transitions:
 *   1. Completed job returns 200 with state 'completed' and the job's returnvalue
 *   2. Failed job returns 400 with state 'failed' and the job's failedReason (as error)
 *   3. Active job returns 200 with state 'active' and the job's progress
 *   4. Waiting job returns 200 with state 'waiting' and the job's progress
 *   5. Unknown jobId for a valid importer returns 404 'job not found'
 *   6. Unknown or unauthorized importer returns 404 'not found'
 *   7. Live BullMQ integration: when Redis is available, a real queued job returns 200 with 'waiting'
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

// ── Env stubs (must precede dynamic imports that read process.env) ────────────
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

// ── Dynamic imports ────────────────────────────────────────────────────────────
const { pool, createSession } = await import('../../db.js');
const { signToken } = await import('../../auth.js');
const { importersRouter } = await import('../../routes/importers.js');
const { txSubmitQueue } = await import('../../queue.js');

// ── Test-run-scoped identifiers ────────────────────────────────────────────────
const testTag = randomUUID().slice(0, 8);
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

// ── Express app wired with the real importersRouter ────────────────────────────
const app = express();
app.use(express.json());
app.use('/importers', importersRouter);
const server = createServer(app);

// ── Mock Job registry for txSubmitQueue.getJob ─────────────────────────────────
type MockJob = {
  getState: () => Promise<string>;
  progress?: unknown;
  returnvalue?: unknown;
  failedReason?: string;
};

const mockJobs = new Map<string, MockJob>();
const originalGetJob = txSubmitQueue.getJob.bind(txSubmitQueue);

// ── State shared across hooks and tests ────────────────────────────────────────
let serverUrl: string;
let dbAvailable = false;
let redisAvailable = false;
let importerUserId: string;
let importerId: string;
let importerToken: string;
const userIds: string[] = [];
const importerIds: string[] = [];

async function getTxStatus(id: string, jobId: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}/importers/${id}/tx-status/${jobId}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      connection: 'close',
    },
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('GET /importers/:id/tx-status/:jobId — BullMQ job state transitions (#595)', () => {
  before(async () => {
    // 1. Intercept txSubmitQueue.getJob to allow deterministic state injection
    (txSubmitQueue as any).getJob = async (jobId: string) => {
      if (mockJobs.has(jobId)) {
        return mockJobs.get(jobId);
      }
      if (redisAvailable) {
        try {
          return await originalGetJob(jobId);
        } catch {
          return null;
        }
      }
      return null;
    };

    // 2. Seed DB with an importer user and importer record
    try {
      const userEmail = `tx-status-595-${testTag}@example.com`;

      const userRow = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer')
         RETURNING id`,
        [userEmail, 'test-hash-not-real']
      );
      importerUserId = userRow.rows[0]!.id;
      userIds.push(importerUserId);

      const impRow = await pool.query<{ id: string }>(
        `INSERT INTO importers
           (user_id, legal_name, bond_id, stellar_address,
            stellar_secret_encrypted, kyc_status)
         VALUES ($1, $2, $3, $4, $5, 'approved')
         RETURNING id`,
        [
          importerUserId,
          `TxStatus Corp ${testTag}`,
          testBondId,
          `GTXSTATUS595${testTag.toUpperCase()}`.padEnd(56, '0'),
          'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
        ]
      );
      importerId = impRow.rows[0]!.id;
      importerIds.push(importerId);

      const sessionId = await createSession(importerUserId);
      importerToken = signToken({
        id: importerUserId,
        email: userEmail,
        role: 'importer',
        sessionId,
      });

      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return; // Skip server startup if DB is unavailable
    }

    // 3. Probe Redis availability (for the optional real BullMQ sub-test)
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

    // 4. Start HTTP server on an ephemeral port
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    // Restore txSubmitQueue.getJob
    (txSubmitQueue as any).getJob = originalGetJob;

    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    // Clean up DB records in dependency order
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

  // ── 1. Completed job returns 200 with state 'completed' and returnvalue ─────────
  it('returns 200 with state "completed" and result for a completed job', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const completedJobId = `job-completed-${testTag}`;
    const mockResult = {
      txHash: '4a6b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b',
      txUrl: 'https://stellar.expert/explorer/testnet/tx/4a6b8c9d0e1f',
      ledgerSequence: 987654,
      applicationOrder: 1,
    };

    mockJobs.set(completedJobId, {
      getState: async () => 'completed',
      returnvalue: mockResult,
      progress: 100,
    });

    const res = await getTxStatus(importerId, completedJobId, importerToken);
    const body = (await res.json()) as { state: string; result: typeof mockResult };

    assert.equal(res.status, 200, 'completed job must return HTTP 200');
    assert.equal(body.state, 'completed', 'state field must be "completed"');
    assert.deepEqual(
      body.result,
      mockResult,
      'result field must match the job returnvalue'
    );
  });

  // ── 2. Failed job returns 400 with state 'failed' and failedReason ─────────────
  it('returns 400 with state "failed" and error message for a failed job', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const failedJobId = `job-failed-${testTag}`;
    const failedReason = 'Transaction simulation failed: Error(Contract, #12)';

    mockJobs.set(failedJobId, {
      getState: async () => 'failed',
      failedReason,
      progress: 0,
    });

    const res = await getTxStatus(importerId, failedJobId, importerToken);
    const body = (await res.json()) as { state: string; error: string };

    assert.equal(res.status, 400, 'failed job must return HTTP 400');
    assert.equal(body.state, 'failed', 'state field must be "failed"');
    assert.equal(
      body.error,
      failedReason,
      'error field must match the job failedReason'
    );
  });

  // ── 3. Active / in-progress job returns 200 with state and progress ────────────
  it('returns 200 with state "active" and progress for an active job', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const activeJobId = `job-active-${testTag}`;
    const mockProgress = 65;

    mockJobs.set(activeJobId, {
      getState: async () => 'active',
      progress: mockProgress,
    });

    const res = await getTxStatus(importerId, activeJobId, importerToken);
    const body = (await res.json()) as { state: string; progress: number };

    assert.equal(res.status, 200, 'active job must return HTTP 200');
    assert.equal(body.state, 'active', 'state field must be "active"');
    assert.equal(
      body.progress,
      mockProgress,
      'progress field must match the job progress'
    );
  });

  // ── 4. Waiting job returns 200 with state "waiting" and progress ───────────────
  it('returns 200 with state "waiting" and progress for a queued waiting job', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const waitingJobId = `job-waiting-${testTag}`;

    mockJobs.set(waitingJobId, {
      getState: async () => 'waiting',
      progress: 0,
    });

    const res = await getTxStatus(importerId, waitingJobId, importerToken);
    const body = (await res.json()) as { state: string; progress: number };

    assert.equal(res.status, 200, 'waiting job must return HTTP 200');
    assert.equal(body.state, 'waiting', 'state field must be "waiting"');
    assert.equal(body.progress, 0, 'progress should be 0 for waiting job');
  });

  // ── 5. Unknown jobId for a valid importer returns 404 'job not found' ──────────
  it('returns 404 with "job not found" when jobId does not exist', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const unknownJobId = `nonexistent-job-${testTag}`;

    const res = await getTxStatus(importerId, unknownJobId, importerToken);
    const body = (await res.json()) as { error: string };

    assert.equal(res.status, 404, 'unknown jobId must return HTTP 404');
    assert.equal(
      body.error,
      'job not found',
      'error message must be "job not found"'
    );
  });

  // ── 6. Nonexistent importer returns 404 'not found' ───────────────────────────
  it('returns 404 with "not found" when importer id does not exist', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const nonexistentImporterId = randomUUID();
    const res = await getTxStatus(nonexistentImporterId, 'any-job-id', importerToken);
    const body = (await res.json()) as { error: string };

    assert.equal(res.status, 404, 'unknown importer must return HTTP 404');
    assert.equal(
      body.error,
      'not found',
      'error message must be "not found"'
    );
  });

  // ── 7. Real BullMQ job in Redis queue (runs when Redis is reachable in CI) ─────
  it('reflects real queued BullMQ job state when Redis is available', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');
    if (!redisAvailable) {
      return t.skip(
        'Redis not reachable — skipping live queue integration check ' +
          '(runs automatically in CI where redis service is active)'
      );
    }

    // Add a real job to the BullMQ txSubmitQueue without worker processing
    const realJob = await txSubmitQueue.add('submit', {
      method: 'deposit',
      importerId,
      args: { amount: '1000' },
    });

    try {
      const res = await getTxStatus(importerId, realJob.id!, importerToken);
      const body = (await res.json()) as { state: string; progress: unknown };

      assert.equal(res.status, 200, 'real queued job must return HTTP 200');
      assert.equal(
        body.state,
        'waiting',
        'newly enqueued BullMQ job without an active worker should be in "waiting" state'
      );
    } finally {
      await realJob.remove().catch(() => undefined);
    }
  });
});
