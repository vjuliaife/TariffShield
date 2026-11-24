import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { importersRouter } from '../../routes/importers.js';
import { env } from '../../config/env.js';
import { contractClient } from '../../stellar.js';
import { refreshImporterMetrics } from '../../db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const JWT_SECRET = env.JWT_SECRET || 'test-jwt-secret-minimum-32-characters-tariffshield';

function createToken(
  user: { id: string; email: string; role: 'importer' | 'surety_admin' },
  sessionId: string
): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      sessionId,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('Issues #585, #586, #587, #588 — Importers Route Integration Tests', () => {
  let server: http.Server;
  let baseUrl: string;

  const testTag = randomUUID().slice(0, 8);

  // Users
  const userAEmail = `importer-a-${testTag}@example.com`;
  const userBEmail = `importer-b-${testTag}@example.com`;
  const userCEmail = `importer-c-unregistered-${testTag}@example.com`;
  const adminEmail = `surety-admin-${testTag}@example.com`;

  let userAId: string;
  let userBId: string;
  let userCId: string;
  let adminId: string;

  let sessionAId: string;
  let sessionBId: string;
  let sessionCId: string;
  let sessionAdminId: string;

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let adminToken: string;

  // Importers
  let importerAId: string;
  let importerBId: string;
  const testBondIdA = Math.floor(Math.random() * 8_000_000) + 1_000_000;
  const testBondIdB = testBondIdA + 1;

  const stellarAddressA = `GA${randomUUID().replace(/-/g, '').slice(0, 54).toUpperCase()}`;
  const stellarAddressB = `GB${randomUUID().replace(/-/g, '').slice(0, 54).toUpperCase()}`;

  // Preserve original getAccount for restore
  const originalGetAccount = (contractClient as any).getAccount;

  // Seeded event IDs for deterministic cursor pagination testing
  const seededEventIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
  ];

  before(async () => {
    // 1. Start ephemeral HTTP server mounting importersRouter
    const app = express();
    app.use(express.json());
    app.use('/importers', importersRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 2. Seed Users
    const uARes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'mock_hash', 'importer')
       RETURNING id`,
      [userAEmail]
    );
    userAId = uARes.rows[0]!.id;

    const uBRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'mock_hash', 'importer')
       RETURNING id`,
      [userBEmail]
    );
    userBId = uBRes.rows[0]!.id;

    const uCRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'mock_hash', 'importer')
       RETURNING id`,
      [userCEmail]
    );
    userCId = uCRes.rows[0]!.id;

    const uAdminRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'mock_hash', 'surety_admin')
       RETURNING id`,
      [adminEmail]
    );
    adminId = uAdminRes.rows[0]!.id;

    // 3. Seed Sessions in user_sessions
    const sARes = await pool.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, last_activity)
       VALUES ($1, now()) RETURNING id`,
      [userAId]
    );
    sessionAId = sARes.rows[0]!.id;

    const sBRes = await pool.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, last_activity)
       VALUES ($1, now()) RETURNING id`,
      [userBId]
    );
    sessionBId = sBRes.rows[0]!.id;

    const sCRes = await pool.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, last_activity)
       VALUES ($1, now()) RETURNING id`,
      [userCId]
    );
    sessionCId = sCRes.rows[0]!.id;

    const sAdminRes = await pool.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, last_activity)
       VALUES ($1, now()) RETURNING id`,
      [adminId]
    );
    sessionAdminId = sAdminRes.rows[0]!.id;

    // 4. Generate Tokens
    tokenA = createToken({ id: userAId, email: userAEmail, role: 'importer' }, sessionAId);
    tokenB = createToken({ id: userBId, email: userBEmail, role: 'importer' }, sessionBId);
    tokenC = createToken({ id: userCId, email: userCEmail, role: 'importer' }, sessionCId);
    adminToken = createToken({ id: adminId, email: adminEmail, role: 'surety_admin' }, sessionAdminId);

    // 5. Seed Importer rows with distinct created_at to verify deterministic ordering
    // Importer A: created earlier
    const impARes = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, stellar_secret_encrypted, created_at)
       VALUES ($1, 'Alpha Electronics Corp', $2, $3, 'secret_encrypted_data_a', now() - INTERVAL '1 hour')
       RETURNING id`,
      [userAId, testBondIdA, stellarAddressA]
    );
    importerAId = impARes.rows[0]!.id;

    // Importer B: created later
    const impBRes = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, stellar_secret_encrypted, created_at)
       VALUES ($1, 'Beta Logistics LLC', $2, $3, 'secret_encrypted_data_b', now())
       RETURNING id`,
      [userBId, testBondIdB, stellarAddressB]
    );
    importerBId = impBRes.rows[0]!.id;

    // 6. Seed bond_records for metrics testing
    await pool.query(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
       VALUES
         ($1, $2, '02', 'Alpha Electronics Corp', '11-1111111', 'Surety Co', '99-9999999', '500000', '100000', CURRENT_DATE),
         ($3, $4, '02', 'Beta Logistics LLC', '22-2222222', 'Surety Co', '99-9999999', '750000', '150000', CURRENT_DATE)`,
      [importerAId, testBondIdA, importerBId, testBondIdB]
    );

    // Refresh materialized view for metrics
    try {
      await refreshImporterMetrics();
    } catch {
      // Fallback if not configured in test DB
    }

    // 7. Mock contractClient.getAccount
    (contractClient as any).getAccount = async (importerAddr: string) => {
      return {
        bondId: importerAddr === stellarAddressA ? BigInt(testBondIdA) : BigInt(testBondIdB),
        collateralBalance: 5000000000n,
        requiredCollateral: 10000000000n,
        reserveBalance: 2000000000n,
        yieldAccrued: 100000000n,
        isClawbacked: false,
        collateralLastUpdated: 1700000000n,
        disputeExpiresAt: 0n,
        preDisputeRequired: 0n,
        disputeRaised: false,
        oracleLastUpdated: 1700000000n,
      };
    };

    // 8. Seed contract_events for Importer A with identical created_at timestamps (Issue #588)
    const fixedTimestamp = new Date('2026-06-01T12:00:00.000Z');
    for (const eventId of seededEventIds) {
      await pool.query(
        `INSERT INTO contract_events (id, importer_id, kind, amount, tx_hash, created_at)
         VALUES ($1, $2, 'deposit_collateral', 1000000, $3, $4)`,
        [eventId, importerAId, `0xmock_tx_${eventId.slice(-4)}`, fixedTimestamp]
      );
    }
  });

  after(async () => {
    // Restore mocked method
    (contractClient as any).getAccount = originalGetAccount;

    // Cleanup database
    if (importerAId || importerBId) {
      await pool.query('DELETE FROM contract_events WHERE importer_id IN ($1, $2)', [
        importerAId,
        importerBId,
      ]);
      await pool.query('DELETE FROM bond_records WHERE importer_id IN ($1, $2)', [
        importerAId,
        importerBId,
      ]);
      await pool.query('DELETE FROM importers WHERE id IN ($1, $2)', [importerAId, importerBId]);
    }

    const userIds = [userAId, userBId, userCId, adminId].filter(Boolean);
    if (userIds.length > 0) {
      await pool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [userIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }

    // Close HTTP server and database pool
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  // ── Issue #585: GET /importers Scopes Results by Caller Role ──────────────
  describe('Issue #585 — GET /importers Role Scoping', () => {
    it('importer token GET /importers returns only rows where user_id matches the caller', async () => {
      const res = await fetch(`${baseUrl}/importers`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res.status, 200, 'importer request should succeed with 200');

      const body = (await res.json()) as { importers: Array<{ id: string; legal_name: string }> };
      assert.ok(Array.isArray(body.importers), 'response should contain an importers array');

      // Must see importer A, and NOT importer B
      assert.strictEqual(body.importers.length, 1, 'importer should only see their own record');
      assert.strictEqual(body.importers[0]!.id, importerAId, 'returned importer ID must match caller');
      assert.strictEqual(
        body.importers[0]!.legal_name,
        'Alpha Electronics Corp',
        'legal name must match caller row'
      );
    });

    it('surety_admin token GET /importers returns all importers ordered by created_at DESC with an email field', async () => {
      const res = await fetch(`${baseUrl}/importers`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200, 'surety admin request should succeed with 200');

      const body = (await res.json()) as {
        importers: Array<{ id: string; email: string; created_at: string }>;
      };
      assert.ok(Array.isArray(body.importers), 'response should contain an importers array');

      const ids = body.importers.map((i) => i.id);
      assert.ok(ids.includes(importerAId), 'surety admin must see importer A');
      assert.ok(ids.includes(importerBId), 'surety admin must see importer B');

      // Check joined email field
      const impA = body.importers.find((i) => i.id === importerAId);
      const impB = body.importers.find((i) => i.id === importerBId);
      assert.strictEqual(impA?.email, userAEmail, 'importer A row must include joined user email');
      assert.strictEqual(impB?.email, userBEmail, 'importer B row must include joined user email');

      // Check descending created_at order between the seeded records
      const indexA = ids.indexOf(importerAId);
      const indexB = ids.indexOf(importerBId);
      // Importer B was created later, so it must appear before Importer A in DESC order
      assert.ok(
        indexB < indexA,
        `importer B (created later) should precede importer A (created earlier) in created_at DESC order. Found indexB: ${indexB}, indexA: ${indexA}`
      );
    });

    it('an importer with no registered importer row gets an empty array, not an error', async () => {
      const res = await fetch(`${baseUrl}/importers`, {
        headers: { Authorization: `Bearer ${tokenC}` },
      });
      assert.strictEqual(res.status, 200, 'unregistered importer request should succeed with 200');

      const body = (await res.json()) as { importers: unknown[] };
      assert.ok(Array.isArray(body.importers), 'response should have an importers array');
      assert.strictEqual(body.importers.length, 0, 'array must be empty for user with no importer row');
    });

    it('response never includes stellar_secret_encrypted for either role', async () => {
      // 1. Check importer response
      const resImporter = await fetch(`${baseUrl}/importers`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const bodyImporter = (await resImporter.json()) as { importers: Record<string, unknown>[] };
      for (const row of bodyImporter.importers) {
        assert.strictEqual(
          row['stellar_secret_encrypted'],
          undefined,
          'importer response must not expose stellar_secret_encrypted'
        );
        assert.strictEqual(
          row['stellarSecretEncrypted'],
          undefined,
          'importer response must not expose stellarSecretEncrypted'
        );
      }

      // 2. Check surety_admin response
      const resAdmin = await fetch(`${baseUrl}/importers`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const bodyAdmin = (await resAdmin.json()) as { importers: Record<string, unknown>[] };
      for (const row of bodyAdmin.importers) {
        assert.strictEqual(
          row['stellar_secret_encrypted'],
          undefined,
          'surety admin response must not expose stellar_secret_encrypted'
        );
        assert.strictEqual(
          row['stellarSecretEncrypted'],
          undefined,
          'surety admin response must not expose stellarSecretEncrypted'
        );
      }
    });
  });

  // ── Issue #586: GET /importers/stats Is Restricted to surety_admin ────────
  describe('Issue #586 — GET /importers/stats Access Control & Routing Precedence', () => {
    it("importer token GET /importers/stats returns 403 'surety admin only'", async () => {
      const res = await fetch(`${baseUrl}/importers/stats`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res.status, 403, 'importer should be rejected with 403');

      const body = (await res.json()) as { error: string };
      assert.strictEqual(body.error, 'surety admin only', 'error message must match specification');
    });

    it('surety_admin token GET /importers/stats returns a metrics object with 200', async () => {
      const res = await fetch(`${baseUrl}/importers/stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200, 'surety admin should receive 200');

      const body = (await res.json()) as { metrics: Record<string, unknown> };
      assert.ok(body.metrics, 'response must include metrics object');
    });

    it("GET /importers/stats is not intercepted by the /:id route (i.e. 'stats' is never treated as an importer id)", async () => {
      // If /stats were intercepted by /:id, it would invoke loadImporterFor with id='stats'
      // which would return a 404 { error: 'not found' }.
      // Verification for surety_admin confirms status 200 and metrics payload.
      const resAdmin = await fetch(`${baseUrl}/importers/stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(resAdmin.status, 200, "surety admin request to /stats should not 404 as an ':id'");
      const bodyAdmin = (await resAdmin.json()) as { metrics?: unknown; error?: string };
      assert.ok(bodyAdmin.metrics, "must return metrics and not '{ error: not found }'");
      assert.strictEqual(bodyAdmin.error, undefined);

      // Verification for importer confirms 403 'surety admin only' rather than 404 'not found'
      const resImporter = await fetch(`${baseUrl}/importers/stats`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(resImporter.status, 403, "importer request should reach /stats guard and not 404 as ':id'");
      const bodyImporter = (await resImporter.json()) as { error: string };
      assert.strictEqual(bodyImporter.error, 'surety admin only');
    });

    it('metrics values reflect the materialized view contents seeded by the test', async () => {
      const res = await fetch(`${baseUrl}/importers/stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);

      const body = (await res.json()) as {
        metrics: {
          totalImporters: number;
          totalBondValue: string;
          avgBalance: string;
          complianceRate: number;
          topupCount30d: number;
          refreshedAt: string;
        };
      };

      const { metrics } = body;
      assert.ok(typeof metrics.totalImporters === 'number', 'totalImporters should be a number');
      assert.ok(metrics.totalImporters >= 2, 'totalImporters must reflect seeded importers');
      assert.ok(typeof metrics.totalBondValue === 'string', 'totalBondValue should be a string');
      assert.ok(typeof metrics.avgBalance === 'string', 'avgBalance should be a string');
      assert.ok(typeof metrics.complianceRate === 'number', 'complianceRate should be a number');
      assert.ok(typeof metrics.topupCount30d === 'number', 'topupCount30d should be a number');
      assert.ok(typeof metrics.refreshedAt === 'string', 'refreshedAt should be an ISO date string');
    });
  });

  // ── Issue #587: GET /importers/:id Multi-Tenant Isolation & Soroban Data ──
  describe('Issue #587 — GET /importers/:id Isolation & Soroban Contract Account Data', () => {
    it("importer token requesting another importer's id returns 404", async () => {
      // Importer A requests Importer B's ID
      const res = await fetch(`${baseUrl}/importers/${importerBId}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res.status, 404, 'cross-tenant request must return 404');

      const body = (await res.json()) as { error: string };
      assert.strictEqual(body.error, 'not found', "error message must be 'not found'");
    });

    it('surety_admin token requesting the same id returns 200 with onChainAccount data', async () => {
      // Surety admin requests Importer B's ID
      const res = await fetch(`${baseUrl}/importers/${importerBId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200, 'surety admin fetching any importer id must return 200');

      const body = (await res.json()) as {
        importer: { id: string; legalName: string; bondId: string | number };
        onChainAccount: {
          bondId: string;
          requiredCollateral: string;
          collateralBalance: string;
          isClawbacked: boolean;
        };
      };

      assert.strictEqual(body.importer.id, importerBId, 'returned importer ID must match requested');
      assert.strictEqual(body.importer.legalName, 'Beta Logistics LLC');

      // Verify onChainAccount data presence
      assert.ok(body.onChainAccount, 'response must include onChainAccount');
      assert.strictEqual(
        body.onChainAccount.bondId,
        String(testBondIdB),
        'bondId in onChainAccount must match contract client'
      );
      assert.strictEqual(
        body.onChainAccount.requiredCollateral,
        '10000000000',
        'requiredCollateral must match contract client'
      );
      assert.strictEqual(
        body.onChainAccount.isClawbacked,
        false,
        'isClawbacked must match contract client'
      );
    });

    it('requesting a non-existent UUID returns 404 for both roles', async () => {
      const nonExistentUuid = randomUUID();

      // Importer role
      const resImporter = await fetch(`${baseUrl}/importers/${nonExistentUuid}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(resImporter.status, 404, 'non-existent UUID must 404 for importer');
      const bodyImporter = (await resImporter.json()) as { error: string };
      assert.strictEqual(bodyImporter.error, 'not found');

      // Surety Admin role
      const resAdmin = await fetch(`${baseUrl}/importers/${nonExistentUuid}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(resAdmin.status, 404, 'non-existent UUID must 404 for surety admin');
      const bodyAdmin = (await resAdmin.json()) as { error: string };
      assert.strictEqual(bodyAdmin.error, 'not found');
    });

    it('response includes bondId, requiredCollateral, and isClawbacked from contractClient.getAccount', async () => {
      const res = await fetch(`${baseUrl}/importers/${importerAId}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res.status, 200);

      const body = (await res.json()) as {
        onChainAccount: {
          bondId: string;
          requiredCollateral: string;
          isClawbacked: boolean;
        };
      };

      assert.ok(body.onChainAccount, 'onChainAccount object must be present');
      assert.strictEqual(
        body.onChainAccount.bondId,
        String(testBondIdA),
        'bondId must match contract client value'
      );
      assert.strictEqual(
        body.onChainAccount.requiredCollateral,
        '10000000000',
        'requiredCollateral must match contract client value'
      );
      assert.strictEqual(
        body.onChainAccount.isClawbacked,
        false,
        'isClawbacked must match contract client value'
      );
    });
  });

  // ── Issue #588: GET /importers/:id/events Cursor Pagination ───────────────
  describe('Issue #588 — GET /importers/:id/events Cursor Pagination & Tiebreaking', () => {
    it('first page returns exactly limit events and a non-null nextCursor when more rows exist', async () => {
      const limit = 2;
      const res = await fetch(`${baseUrl}/importers/${importerAId}/events?limit=${limit}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res.status, 200);

      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        nextCursor: string | null;
      };

      assert.strictEqual(body.data.length, limit, `first page must return exactly limit (${limit}) events`);
      assert.ok(body.nextCursor, 'nextCursor must be non-null when additional events remain');
      assert.strictEqual(
        body.nextCursor,
        body.data[body.data.length - 1]!.id,
        'nextCursor must equal the ID of the last event on the current page'
      );
    });

    it('following nextCursor returns the next page continuing the same descending order', async () => {
      const limit = 2;

      // Page 1
      const res1 = await fetch(`${baseUrl}/importers/${importerAId}/events?limit=${limit}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const page1 = (await res1.json()) as { data: Array<{ id: string }>; nextCursor: string };
      assert.ok(page1.nextCursor);

      // Page 2 using nextCursor
      const res2 = await fetch(
        `${baseUrl}/importers/${importerAId}/events?limit=${limit}&cursor=${page1.nextCursor}`,
        {
          headers: { Authorization: `Bearer ${tokenA}` },
        }
      );
      assert.strictEqual(res2.status, 200);
      const page2 = (await res2.json()) as { data: Array<{ id: string }>; nextCursor: string };

      assert.strictEqual(page2.data.length, limit, `page 2 must return ${limit} events`);
      assert.ok(page2.nextCursor, 'page 2 nextCursor must be non-null as more events remain');

      // Verify no duplicates between page 1 and page 2
      const page1Ids = new Set(page1.data.map((e) => e.id));
      for (const item of page2.data) {
        assert.ok(
          !page1Ids.has(item.id),
          `duplicate event ID ${item.id} detected across pagination boundaries`
        );
      }

      // Verify descending order across page boundary (id < cursor)
      assert.ok(
        page2.data[0]!.id < page1.data[page1.data.length - 1]!.id,
        'page 2 first item must be strictly smaller than page 1 last item'
      );
    });

    it('the final page returns nextCursor: null once all rows are exhausted', async () => {
      const limit = 2;

      // Page 1 (items 1 & 2 of 5)
      const res1 = await fetch(`${baseUrl}/importers/${importerAId}/events?limit=${limit}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const page1 = (await res1.json()) as { nextCursor: string };

      // Page 2 (items 3 & 4 of 5)
      const res2 = await fetch(
        `${baseUrl}/importers/${importerAId}/events?limit=${limit}&cursor=${page1.nextCursor}`,
        {
          headers: { Authorization: `Bearer ${tokenA}` },
        }
      );
      const page2 = (await res2.json()) as { nextCursor: string };

      // Page 3 (item 5 of 5 — final page)
      const res3 = await fetch(
        `${baseUrl}/importers/${importerAId}/events?limit=${limit}&cursor=${page2.nextCursor}`,
        {
          headers: { Authorization: `Bearer ${tokenA}` },
        }
      );
      assert.strictEqual(res3.status, 200);
      const page3 = (await res3.json()) as { data: Array<{ id: string }>; nextCursor: string | null };

      assert.strictEqual(page3.data.length, 1, 'final page should return remaining 1 event');
      assert.strictEqual(
        page3.nextCursor,
        null,
        'nextCursor must be null on the final page when rows are exhausted'
      );
    });

    it('events with identical created_at timestamps are still ordered deterministically via the id tiebreaker', async () => {
      // Fetch all pages and verify all 5 seeded events round-trip in strict descending order
      const collectedIds: string[] = [];
      let cursor: string | null = null;
      const limit = 2;

      do {
        const url = cursor
          ? `${baseUrl}/importers/${importerAId}/events?limit=${limit}&cursor=${cursor}`
          : `${baseUrl}/importers/${importerAId}/events?limit=${limit}`;

        const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenA}` } });
        assert.strictEqual(res.status, 200);

        const page = (await res.json()) as { data: Array<{ id: string }>; nextCursor: string | null };
        for (const event of page.data) {
          collectedIds.push(event.id);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);

      assert.strictEqual(collectedIds.length, 5, 'all 5 events must be collected');

      // Verify strict descending order by ID
      for (let i = 0; i < collectedIds.length - 1; i++) {
        assert.ok(
          collectedIds[i]! > collectedIds[i + 1]!,
          `deterministic descending tiebreaker violated: ${collectedIds[i]} is not > ${collectedIds[i + 1]}`
        );
      }

      // Verify matches expected sorted list
      const expectedIdsDesc = [...seededEventIds].sort((a, b) => (b < a ? -1 : 1));
      assert.deepStrictEqual(
        collectedIds,
        expectedIdsDesc,
        'events must match exact reverse sorted order of seeded IDs'
      );
    });
  });
});
