/**
 * Integration coverage for GET /importers/:id/collateral-status staleness
 * (issue #590).
 *
 * Exercises the real route handler in routes/importers.ts with
 * contractClient.getAccount stubbed to return a controlled
 * collateralLastUpdated timestamp. The handler derives
 * expiresAt = lastUpdated + 365 days and flags the account stale once now()
 * passes that instant, so these cases pin the boundary in both directions.
 * The handler is invoked directly (bypassing authMiddleware) with a
 * surety_admin principal, matching the pattern used in
 * feature-633-639-route-guards.test.ts. A live, migrated database is required.
 *
 * Run via: npm run test:integration --workspace=apps/api
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
const { importersRouter } = await import('../../routes/importers.js');
const { contractClient } = await import('../../stellar.js');

const DAY_SECONDS = 86_400;
const YEAR_SECONDS = 365 * DAY_SECONDS;

function route(path: string, method: string, router: any) {
  const layer = router.stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);
  return layer.route.stack;
}

function response() {
  const result: { statusCode: number; body: any } = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  };
  return { res, result };
}

const tag = randomUUID().slice(0, 8);
const importerEmail = `collateral-status-importer-${tag}@example.com`;
const suretyEmail = `collateral-status-surety-${tag}@example.com`;

let importerUserId: string;
let suretyUserId: string;
let importerId: string;
let dbAvailable = false;

/** Replaces the on-chain account read with a fixed collateralLastUpdated. */
function stubCollateralLastUpdated(lastUpdatedSeconds: number) {
  (contractClient as any).getAccount = async () => ({
    collateralLastUpdated: BigInt(lastUpdatedSeconds),
  });
}

async function callCollateralStatus() {
  const handlers = route('/:id/collateral-status', 'get', importersRouter);
  const { res, result } = response();
  await handlers[0](
    { user: { id: suretyUserId, role: 'surety_admin' }, params: { id: importerId }, query: {} },
    res,
    () => undefined
  );
  return result;
}

describe('GET /importers/:id/collateral-status staleness (#590)', () => {
  before(async () => {
    try {
      const importerUser = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, 'integration-test-hash', 'importer') RETURNING id`,
        [importerEmail]
      );
      importerUserId = importerUser.rows[0]!.id;

      const suretyUser = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, 'integration-test-hash', 'surety_admin') RETURNING id`,
        [suretyEmail]
      );
      suretyUserId = suretyUser.rows[0]!.id;

      const bondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
      const importer = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status)
         VALUES ($1, $2, $3, $4, 'approved') RETURNING id`,
        [importerUserId, `Collateral Status Corp ${tag}`, bondId, `G${tag.toUpperCase()}COLLATERALADDR`]
      );
      importerId = importer.rows[0]!.id;

      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    // Drop the own property created by the stub so the proxied prototype
    // method is used again.
    delete (contractClient as any).getAccount;

    if (dbAvailable && importerId) {
      await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
    }
    if (dbAvailable && suretyUserId) {
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, suretyUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('yields stale: true when collateralLastUpdated is older than 365 days', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const lastUpdatedSeconds = Math.floor(Date.now() / 1000) - (366 * DAY_SECONDS);
    stubCollateralLastUpdated(lastUpdatedSeconds);

    const result = await callCollateralStatus();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.stale, true);
  });

  it('yields stale: false when collateralLastUpdated is within 365 days', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const lastUpdatedSeconds = Math.floor(Date.now() / 1000) - (10 * DAY_SECONDS);
    stubCollateralLastUpdated(lastUpdatedSeconds);

    const result = await callCollateralStatus();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.stale, false);
  });

  it('returns expiresAt equal to lastUpdated + 365 days exactly', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const lastUpdatedSeconds = 1_700_000_000;
    stubCollateralLastUpdated(lastUpdatedSeconds);

    const result = await callCollateralStatus();

    assert.equal(result.statusCode, 200);
    assert.equal(
      result.body.lastUpdated,
      new Date(lastUpdatedSeconds * 1000).toISOString()
    );
    assert.equal(
      result.body.expiresAt,
      new Date((lastUpdatedSeconds + YEAR_SECONDS) * 1000).toISOString()
    );
  });

  it('returns ISO 8601 timestamps, not raw epoch seconds', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const lastUpdatedSeconds = 1_700_000_000;
    stubCollateralLastUpdated(lastUpdatedSeconds);

    const result = await callCollateralStatus();

    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.equal(typeof result.body.lastUpdated, 'string');
    assert.equal(typeof result.body.expiresAt, 'string');
    assert.match(result.body.lastUpdated, iso);
    assert.match(result.body.expiresAt, iso);
    // A raw epoch-seconds value would parse as a finite number.
    assert.ok(Number.isNaN(Number(result.body.lastUpdated)));
    assert.ok(Number.isNaN(Number(result.body.expiresAt)));
  });
});
