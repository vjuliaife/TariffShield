/**
 * Integration coverage for POST /importers/:id/upload-tariff-csv HTS rate
 * rejection (issue #591).
 *
 * Drives the real route handler in routes/importers.ts. validateHtsRates reads
 * its statutory rates from the `hts_rate_cache` table (with the USITC API as a
 * fallback), so the test seeds that cache directly to pin the declared rate
 * into a blocking (underreported) or non-blocking (overreported) outcome
 * without any network access. contractClient.setRequiredCollateral is stubbed
 * so the test can assert it is never reached for a rejected upload.
 *
 * NOTE: `hts_rate_cache` is queried by services/hts-rate-validator.ts but has no
 * CREATE TABLE anywhere in the schema (src/migrations/, apps/api/migrations/),
 * so this test provisions it. Without the table the handler throws a 500
 * before it can return the 422/200 the acceptance criteria describe.
 *
 * Run via: npm run test:integration --workspace=apps/api
 */

import { after, before, beforeEach, describe, it } from 'node:test';
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
const digits = () => String(Math.floor(Math.random() * 9000) + 1000);
const importerEmail = `tariff-upload-importer-${tag}@example.com`;
const suretyEmail = `tariff-upload-surety-${tag}@example.com`;

// Underreported: route returns 422 before the CBP / on-chain stages.
const blockingHtsCode = `8543${digits()}`;
// Overreported: non-blocking warning. First four digits are '1000', so
// lookupCbpDutyRate's deterministic mock rate is (1000 % 25) / 100 === 0, which
// keeps the legacy CBP stage from adding its own block error.
const warningHtsCode = `1000${digits()}`;
const statutoryRate = 0.1;

let importerUserId: string;
let suretyUserId: string;
let importerId: string;
let dbAvailable = false;
let setRequiredCollateralCalls = 0;

async function callUpload(body: unknown) {
  const handlers = route('/:id/upload-tariff-csv', 'post', importersRouter);
  const { res, result } = response();
  await handlers[0](
    { user: { id: suretyUserId, role: 'surety_admin' }, params: { id: importerId }, body },
    res,
    () => undefined
  );
  return result;
}

describe('POST /importers/:id/upload-tariff-csv HTS rejection (#591)', () => {
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
        [importerUserId, `Tariff Upload Corp ${tag}`, bondId, `G${tag.toUpperCase()}TARIFFUPLOADADDR`]
      );
      importerId = importer.rows[0]!.id;

      // See the file header: hts_rate_cache has no migration in this repo.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS hts_rate_cache (
          hts_code TEXT PRIMARY KEY,
          statutory_rate DOUBLE PRECISION,
          is_unavailable BOOLEAN NOT NULL DEFAULT false,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      for (const htsCode of [blockingHtsCode, warningHtsCode]) {
        await pool.query(
          `INSERT INTO hts_rate_cache (hts_code, statutory_rate, is_unavailable, fetched_at)
           VALUES ($1, $2, false, now())
           ON CONFLICT (hts_code)
           DO UPDATE SET statutory_rate = EXCLUDED.statutory_rate,
                         is_unavailable = false,
                         fetched_at = now()`,
          [htsCode, statutoryRate]
        );
      }

      // The blocking path must never reach the on-chain call; the warning path
      // does, so return a minimal successful result shape.
      (contractClient as any).setRequiredCollateral = async () => {
        setRequiredCollateralCalls += 1;
        return { txHash: 'stub-collateral-tx', ledgerSequence: 42, applicationOrder: 0 };
      };

      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    setRequiredCollateralCalls = 0;
  });

  after(async () => {
    delete (contractClient as any).setRequiredCollateral;

    if (dbAvailable && importerId) {
      await pool.query('DELETE FROM contract_events WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM tariff_uploads WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
    }
    if (dbAvailable) {
      await pool.query('DELETE FROM hts_rate_cache WHERE hts_code IN ($1, $2)', [
        blockingHtsCode,
        warningHtsCode,
      ]);
    }
    if (dbAvailable && suretyUserId) {
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, suretyUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('returns 422 with the flagged htsCode when a line item is underreported', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const result = await callUpload({
      filename: 'blocked.csv',
      lineItems: [{ htsCode: blockingHtsCode, value: 1000, dutyRate: 0.05 }],
    });

    assert.equal(result.statusCode, 422);
    assert.ok(Array.isArray(result.body.flagged));
    assert.equal(result.body.flagged.length, 1);
    const flagged = result.body.flagged[0];
    assert.equal(flagged.htsCode, blockingHtsCode);
    assert.equal(flagged.declaredRate, 0.05);
    assert.equal(flagged.statutoryRate, statutoryRate);
    assert.equal(typeof flagged.message, 'string');
  });

  it('never calls contractClient.setRequiredCollateral when blocking errors are present', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const result = await callUpload({
      filename: 'blocked.csv',
      lineItems: [{ htsCode: blockingHtsCode, value: 1000, dutyRate: 0.05 }],
    });

    assert.equal(result.statusCode, 422);
    assert.equal(setRequiredCollateralCalls, 0);
  });

  it('writes no tariff_uploads row for the rejected upload', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tariff_uploads WHERE importer_id = $1',
      [importerId]
    );

    const result = await callUpload({
      filename: 'blocked.csv',
      lineItems: [{ htsCode: blockingHtsCode, value: 1000, dutyRate: 0.05 }],
    });

    const after = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tariff_uploads WHERE importer_id = $1',
      [importerId]
    );

    assert.equal(result.statusCode, 422);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  });

  it('proceeds to 200 with htsWarnings for a non-blocking overreport', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const result = await callUpload({
      filename: 'warn.csv',
      lineItems: [{ htsCode: warningHtsCode, value: 1000, dutyRate: 0.2 }],
    });

    assert.equal(result.statusCode, 200);
    assert.ok(Array.isArray(result.body.htsWarnings));
    assert.equal(result.body.htsWarnings.length, 1);
    assert.equal(result.body.htsWarnings[0].htsCode, warningHtsCode);
    assert.equal(result.body.htsWarnings[0].status, 'overreported');
    assert.equal(setRequiredCollateralCalls, 1);
  });
});
