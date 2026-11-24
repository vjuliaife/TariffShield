/**
 * Integration tests for POST /importers/:id/verify-oracle-data (#594).
 *
 * Covers all acceptance criteria from issue #594:
 *   1. Deviation > 1%  → match:false  + oracle_alerts row with tx_hash 'reconciliation_failure'
 *   2. Deviation ≤ 1%  → match:true   + no oracle_alerts row inserted
 *   3. Missing tariff_uploads data   → 404
 *   4. as_of_date query param        → selects the most-recent upload at or before that date
 *
 * Strategy: direct route-handler invocation (feature-636-641 pattern).
 *   – Bypasses authMiddleware / privacyGate / tosGate entirely; req.user is
 *     injected synthetically, which is correct because those middleware layers
 *     are covered by their own test files.
 *   – getRequiredCollateralOnChain is replaced before importers.ts loads, so
 *     no live Soroban RPC connection is opened and the test never touches Redis.
 *   – All DB work (users, importers, tariff_uploads, oracle_alerts) runs
 *     against the real PostgreSQL test instance; the test self-cleans in after().
 *
 * Run via: npm run test:integration --workspace=apps/api
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

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

// ── Stub stellar module BEFORE importers.ts loads it ──────────────────────────
// The route handler calls getRequiredCollateralOnChain() from stellar.ts which
// would open a live Soroban RPC connection. We replace the whole stellar module
// with a minimal stub that lets the test control the on-chain value.
//
// onChainValue is set per-test to exercise the deviation branches.
let onChainValue = '0';
await mock.module('../../stellar.js', {
  namedExports: {
    getRequiredCollateralOnChain: async (_addr: string) => onChainValue,
    // The route also imports contractClient, platformKeypair, explorerTx.
    // Provide safe no-op stubs so the module loads without errors.
    contractClient: {},
    platformKeypair: { publicKey: () => 'GSTUB' },
    explorerTx: (hash: string) => `https://example.com/tx/${hash}`,
    getRequiredCollateralOnChain_STUB_SIGNAL: true, // marker for debugging
  },
});

// ── Dynamic imports (must come after mock.module so stubs are in place) ────────
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });

// importersRouter is loaded now; its top-level import of stellar.js is already
// intercepted by mock.module above, so getRequiredCollateralOnChain is our stub.
const { importersRouter } = await import('../../routes/importers.js');

// ── Helper: extract the last handler registered for a route ───────────────────
// stackIndex -1 targets the actual business-logic handler (the final entry),
// skipping any per-route middleware that may have been prepended.
function routeHandler(router: any, path: string, method: string, stackIndex = -1) {
  const layer = (router.stack as any[]).find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered on importersRouter`);
  const idx = stackIndex < 0 ? layer.route.stack.length + stackIndex : stackIndex;
  return layer.route.stack[idx].handle;
}

// ── Minimal Express-compatible res object ─────────────────────────────────────
type Captured = { statusCode: number; body: unknown };
function makeRes(): { res: any; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(body: unknown)  { captured.body = body; return this; },
    send(body: unknown)  { captured.body = body; return this; },
  };
  return { res, captured };
}

// ── Test state ─────────────────────────────────────────────────────────────────
const tag = randomUUID().slice(0, 8);
let dbAvailable = false;
let importerUserId: string;
let importerId: string;
let uploadId: string;
let olderUploadId: string;
let noUploadImporterId: string;
const userIds: string[] = [];
const importerIds: string[] = [];
const testBondId  = Math.floor(Math.random() * 9_000_000) + 1_000_000;
const testBondId2 = Math.floor(Math.random() * 9_000_000) + 1_000_000;

// ── Maths that must stay consistent with the route ────────────────────────────
// Route formula: computed = round(annualDuty * 0.1 * 0.5 * 1e7)
// We seed annual_duty_total so the computed value is a round number we can reason
// about without floating-point ambiguity.
//
// annualDuty = 400_000  →  computed = round(400_000 * 0.1 * 0.5 * 1e7) = 200_000_000_000
const ANNUAL_DUTY  = '400000.00';        // stored in tariff_uploads
const COMPUTED_REQ = 200_000_000_000n;   // expected value the route derives

// On-chain value that is WITHIN 1 % of computed (deviation = 0 %)
const ON_CHAIN_MATCH  = COMPUTED_REQ.toString();
// On-chain value that deviates by > 1 % (deviation ≈ 5 %)
const ON_CHAIN_DEVIATE = (COMPUTED_REQ * 95n / 100n).toString();  // 190_000_000_000

// Handler reference retrieved once (router is built at import time)
let verifyHandler: (req: any, res: any) => Promise<void>;

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('POST /importers/:id/verify-oracle-data — oracle reconciliation (#594)', () => {
  before(async () => {
    try {
      // User + importer for the main test scenarios
      const userRow = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer') RETURNING id`,
        [`oracle-594-${tag}@example.com`, 'test-hash-not-real']
      );
      importerUserId = userRow.rows[0]!.id;
      userIds.push(importerUserId);

      const impRow = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          importerUserId,
          `Oracle Recon Test Corp ${tag}`,
          testBondId,
          `GTESTORACLE594${tag.toUpperCase()}`.padEnd(56, '0'),
        ]
      );
      importerId = impRow.rows[0]!.id;
      importerIds.push(importerId);

      // Primary tariff_uploads row: used by the deviation and no-deviation tests.
      const upRow = await pool.query<{ id: string }>(
        `INSERT INTO tariff_uploads
           (importer_id, filename, annual_duty_total, computed_required_collateral, created_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5) RETURNING id`,
        [
          importerId,
          'duties-2026.csv',
          ANNUAL_DUTY,
          COMPUTED_REQ.toString(),
          '2026-06-15T12:00:00Z',   // "current" upload timestamp
        ]
      );
      uploadId = upRow.rows[0]!.id;

      // Older upload: annual_duty_total differs so the route derives a different
      // computed value — used for the as_of_date test.
      const olderRow = await pool.query<{ id: string }>(
        `INSERT INTO tariff_uploads
           (importer_id, filename, annual_duty_total, computed_required_collateral, created_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5) RETURNING id`,
        [
          importerId,
          'duties-2026-q1.csv',
          '200000.00',       // half the annual duty → computed = 100_000_000_000
          '100000000000',
          '2026-03-01T00:00:00Z',   // earlier
        ]
      );
      olderUploadId = olderRow.rows[0]!.id;

      // Second importer deliberately has NO tariff_uploads row (404 scenario).
      const user2Row = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer') RETURNING id`,
        [`oracle-noupload-${tag}@example.com`, 'test-hash-not-real']
      );
      userIds.push(user2Row.rows[0]!.id);

      const imp2Row = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          user2Row.rows[0]!.id,
          `No Upload Corp ${tag}`,
          testBondId2,
          `GTESTRACLE594NOUPLOAD${tag.toUpperCase()}`.padEnd(56, '0'),
        ]
      );
      noUploadImporterId = imp2Row.rows[0]!.id;
      importerIds.push(noUploadImporterId);

      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }

    // Extract handler once — routing is static after import
    verifyHandler = routeHandler(importersRouter, '/:id/verify-oracle-data', 'post');
  });

  after(async () => {
    // Clean up in dependency order: oracle_alerts → tariff_uploads → importers → users
    await pool
      .query('DELETE FROM oracle_alerts WHERE importer_id = ANY($1::uuid[])', [importerIds])
      .catch(() => undefined);
    if (uploadId || olderUploadId) {
      await pool
        .query('DELETE FROM tariff_uploads WHERE id = ANY($1::uuid[])', [
          [uploadId, olderUploadId].filter(Boolean),
        ])
        .catch(() => undefined);
    }
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

  // ── 1. Deviation > 1 % → match:false + oracle_alerts row ──────────────────
  it('returns match:false and inserts a reconciliation_failure oracle_alerts row when deviation > 1%', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    // Stub on-chain value that deviates ≈ 5 % below computed
    onChainValue = ON_CHAIN_DEVIATE;

    const { res, captured } = makeRes();
    await verifyHandler(
      { params: { id: importerId }, body: {}, user: { id: importerUserId, role: 'importer' } },
      res
    );

    // ── Route-level assertions ─────────────────────────────────────────────────
    const body = captured.body as any;
    assert.equal(captured.statusCode, 200, 'route should still respond 200 — alert is a side-effect');
    assert.equal(body.match, false, 'match must be false when deviation exceeds 1%');
    assert.equal(body.computed, COMPUTED_REQ.toString(), 'computed value must equal formula result');
    assert.equal(body.on_chain, ON_CHAIN_DEVIATE, 'on_chain value must echo the stubbed RPC result');
    assert.ok(
      typeof body.deviation_pct === 'number' && body.deviation_pct > 1,
      'deviation_pct must be numeric and > 1'
    );
    assert.ok(typeof body.csv_hash === 'string' && body.csv_hash.length === 64, 'csv_hash must be a 64-char hex SHA-256');
    assert.ok(typeof body.collateral_timestamp === 'string', 'collateral_timestamp must be present');

    // ── DB side-effect assertion ───────────────────────────────────────────────
    const alert = await pool.query<{
      importer_id: string;
      old_value: string;
      new_value: string;
      tx_hash: string;
      pct_change: string;
    }>(
      `SELECT importer_id, old_value::text, new_value::text, tx_hash, pct_change::text
         FROM oracle_alerts
        WHERE importer_id = $1
        ORDER BY alerted_at DESC
        LIMIT 1`,
      [importerId]
    );

    assert.equal(alert.rowCount, 1, 'exactly one oracle_alerts row should be inserted');
    const row = alert.rows[0]!;
    assert.equal(row.importer_id, importerId, 'alert must reference the correct importer');
    assert.equal(row.tx_hash, 'reconciliation_failure', 'tx_hash sentinel must be reconciliation_failure');
    assert.equal(row.old_value, ON_CHAIN_DEVIATE, 'old_value must be the on-chain (previous) value');
    assert.equal(row.new_value, COMPUTED_REQ.toString(), 'new_value must be the freshly computed value');
    assert.ok(Number(row.pct_change) > 1, 'pct_change stored in DB must be > 1');
  });

  // ── 2. Deviation ≤ 1 % → match:true + no oracle_alerts row ───────────────
  it('returns match:true and writes no oracle_alerts row when deviation is within 1%', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    // Delete any alert that test 1 may have inserted so the count is clean
    await pool.query('DELETE FROM oracle_alerts WHERE importer_id = $1', [importerId]);

    // Stub on-chain value that exactly matches computed → deviation 0 %
    onChainValue = ON_CHAIN_MATCH;

    const { res, captured } = makeRes();
    await verifyHandler(
      { params: { id: importerId }, body: {}, user: { id: importerUserId, role: 'importer' } },
      res
    );

    const body = captured.body as any;
    assert.equal(captured.statusCode, 200);
    assert.equal(body.match, true, 'match must be true when deviation is 0%');
    assert.equal(body.deviation_pct, 0, 'deviation_pct must be 0 for an exact match');

    // No oracle_alerts row should have been written
    const alert = await pool.query(
      'SELECT id FROM oracle_alerts WHERE importer_id = $1',
      [importerId]
    );
    assert.equal(alert.rowCount, 0, 'no oracle_alerts row should be inserted for a matching value');
  });

  // ── 3. Missing tariff_uploads → 404 ───────────────────────────────────────
  it('returns 404 when the importer has no tariff_uploads row', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    onChainValue = '0'; // irrelevant for the 404 path, but keep state predictable

    const { res, captured } = makeRes();
    await verifyHandler(
      {
        params: { id: noUploadImporterId },
        body: {},
        // Use the second user as surety_admin so the route uses the simpler lookup branch
        user: { id: importerUserId, role: 'surety_admin' },
      },
      res
    );

    const body = captured.body as any;
    assert.equal(captured.statusCode, 404);
    assert.equal(body.error, 'no tariff CSV data found for this importer');
  });

  // ── 4. as_of_date selects the most-recent upload ≤ that date ─────────────
  it('as_of_date param selects the most-recent upload at or before that date', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    // The importer has two uploads:
    //   – olderUpload: created_at = 2026-03-01, annual_duty = 200_000  → computed = 100_000_000_000
    //   – uploadId:    created_at = 2026-06-15, annual_duty = 400_000  → computed = 200_000_000_000
    //
    // Requesting as_of_date = 2026-04-01 must pick the OLDER row.
    const olderComputed = 100_000_000_000n;

    // Set on-chain to exactly the OLDER computed value so match = true for that
    // row, while it would be a large deviation against the NEWER row.
    onChainValue = olderComputed.toString();

    const { res, captured } = makeRes();
    await verifyHandler(
      {
        params: { id: importerId },
        // as_of_date in the route comes from req.body (VerifyOracleSchema)
        body: { as_of_date: '2026-04-01T00:00:00.000Z' },
        user: { id: importerUserId, role: 'importer' },
      },
      res
    );

    const body = captured.body as any;
    assert.equal(captured.statusCode, 200);
    assert.equal(
      body.computed,
      olderComputed.toString(),
      'computed must be derived from the older upload selected by as_of_date'
    );
    assert.equal(body.match, true, 'must be a match when on-chain equals the older upload computed value');
    assert.equal(body.on_chain, olderComputed.toString());

    // Confirm that the NEWER upload would have produced a different computed value
    // (sanity-check that the date filter actually worked)
    assert.notEqual(body.computed, COMPUTED_REQ.toString());
  });
});
