/**
 * Integration coverage for POST /admin/refresh-hts-cache (#600).
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

interface RefreshHtsCacheResponse {
  message?: string;
  deletedRows?: number;
  htsCodes?: string[] | string;
  error?: string;
  target?: string;
  details?: unknown;
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const server = createServer(app);

let serverUrl: string;
let suretyToken: string;
let importerToken: string;
let suretyUserId: string;
let importerUserId: string;

async function refreshHtsCache(
  body?: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    connection: 'close',
  };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(`${serverUrl}/admin/refresh-hts-cache`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedCacheRow(
  htsCode: string,
  rate: number = 0.05,
  unavailable: boolean = false
): Promise<void> {
  await pool.query(
    `INSERT INTO hts_rate_cache (hts_code, statutory_rate, is_unavailable, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (hts_code)
     DO UPDATE SET statutory_rate = EXCLUDED.statutory_rate,
                   is_unavailable = EXCLUDED.is_unavailable,
                   fetched_at = EXCLUDED.fetched_at`,
    [htsCode, rate, unavailable]
  );
}

async function hasCacheRow(htsCode: string): Promise<boolean> {
  const res = await pool.query<{ hts_code: string }>(
    'SELECT hts_code FROM hts_rate_cache WHERE hts_code = $1',
    [htsCode]
  );
  return (res.rowCount ?? 0) > 0;
}

async function countCacheRows(): Promise<number> {
  const res = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM hts_rate_cache');
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

describe('POST /admin/refresh-hts-cache integration (#600)', () => {
  before(async () => {
    // Ensure hts_rate_cache table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hts_rate_cache (
        hts_code       TEXT PRIMARY KEY,
        statutory_rate NUMERIC(8, 6),
        is_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
        fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_hts_rate_cache_fetched ON hts_rate_cache(fetched_at);
    `);

    // 1. Create surety_admin user and session
    const surety = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'surety_admin')
       RETURNING id, email`,
      [`surety-hts-${testTag}@example.com`, 'test-hash-not-real']
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
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id, email`,
      [`importer-hts-${testTag}@example.com`, 'test-hash-not-real']
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
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  it('Supplying specific htsCodes only removes cache rows for those codes, leaving others intact', async () => {
    const codeA = `8471.30.${testTag.slice(0, 2)}`;
    const codeB = `6110.20.${testTag.slice(0, 2)}`;
    const codeC = `0901.21.${testTag.slice(0, 2)}`;

    // Seed 3 cache rows
    await seedCacheRow(codeA, 0.05);
    await seedCacheRow(codeB, 0.12);
    await seedCacheRow(codeC, 0.02);

    assert.strictEqual(await hasCacheRow(codeA), true);
    assert.strictEqual(await hasCacheRow(codeB), true);
    assert.strictEqual(await hasCacheRow(codeC), true);

    // Bust only codeA and codeB
    const response = await refreshHtsCache({ htsCodes: [codeA, codeB] }, suretyToken);
    assert.strictEqual(response.status, 200, 'bust request should return 200');
    const body = (await response.json()) as RefreshHtsCacheResponse;

    assert.strictEqual(body.deletedRows, 2, 'deletedRows should be 2');
    assert.strictEqual(body.message, 'Cache busted for 2 HTS code(s)');
    assert.deepStrictEqual(body.htsCodes, [codeA, codeB]);

    // Verify codeA and codeB were deleted, while codeC remains intact
    assert.strictEqual(await hasCacheRow(codeA), false, `${codeA} should have been removed`);
    assert.strictEqual(await hasCacheRow(codeB), false, `${codeB} should have been removed`);
    assert.strictEqual(await hasCacheRow(codeC), true, `${codeC} should remain intact in cache`);
  });

  it('Omitting htsCodes (or an empty array) clears the full cache and reports "Full HTS rate cache cleared"', async () => {
    // 1. Test with empty array []
    const code1 = `1111.00.${testTag.slice(0, 2)}`;
    const code2 = `2222.00.${testTag.slice(0, 2)}`;
    await seedCacheRow(code1, 0.03);
    await seedCacheRow(code2, 0.07);

    const emptyArrayRes = await refreshHtsCache({ htsCodes: [] }, suretyToken);
    assert.strictEqual(emptyArrayRes.status, 200);
    const emptyArrayBody = (await emptyArrayRes.json()) as RefreshHtsCacheResponse;

    assert.strictEqual(emptyArrayBody.message, 'Full HTS rate cache cleared');
    assert.strictEqual(emptyArrayBody.htsCodes, 'all');
    assert.ok(emptyArrayBody.deletedRows! >= 2, 'should delete at least the seeded rows');
    assert.strictEqual(await countCacheRows(), 0, 'cache must be completely empty');

    // 2. Test with omitted htsCodes (empty object {})
    const code3 = `3333.00.${testTag.slice(0, 2)}`;
    await seedCacheRow(code3, 0.04);
    assert.strictEqual(await countCacheRows(), 1);

    const omittedRes = await refreshHtsCache({}, suretyToken);
    assert.strictEqual(omittedRes.status, 200);
    const omittedBody = (await omittedRes.json()) as RefreshHtsCacheResponse;

    assert.strictEqual(omittedBody.message, 'Full HTS rate cache cleared');
    assert.strictEqual(omittedBody.htsCodes, 'all');
    assert.strictEqual(omittedBody.deletedRows, 1);
    assert.strictEqual(await countCacheRows(), 0, 'cache must be completely empty');
  });

  it('deletedRows in the response matches the actual number of rows removed', async () => {
    const codeX = `4444.10.${testTag.slice(0, 2)}`;
    const codeY = `4444.20.${testTag.slice(0, 2)}`;
    const codeZ = `4444.30.${testTag.slice(0, 2)}`;
    const nonExistent = `9999.99.${testTag.slice(0, 2)}`;

    await seedCacheRow(codeX, 0.01);
    await seedCacheRow(codeY, 0.02);
    await seedCacheRow(codeZ, 0.03);

    // Request busting 2 existing rows + 1 non-existent row
    const response = await refreshHtsCache(
      { htsCodes: [codeX, codeY, nonExistent] },
      suretyToken
    );
    assert.strictEqual(response.status, 200);
    const body = (await response.json()) as RefreshHtsCacheResponse;

    // deletedRows should be exactly 2 because nonExistent wasn't in the cache
    assert.strictEqual(body.deletedRows, 2, 'deletedRows must match actual rows removed from DB');
    assert.strictEqual(body.message, 'Cache busted for 3 HTS code(s)');

    // Busting the non-existent code again should report deletedRows = 0
    const emptyBustRes = await refreshHtsCache({ htsCodes: [nonExistent] }, suretyToken);
    const emptyBustBody = (await emptyBustRes.json()) as RefreshHtsCacheResponse;
    assert.strictEqual(emptyBustBody.deletedRows, 0, 'deletedRows must be 0 when no rows match');
  });

  it('importer-role token is rejected with 403 before any cache mutation', async () => {
    const protectedCode = `7777.77.${testTag.slice(0, 2)}`;
    await seedCacheRow(protectedCode, 0.08);
    assert.strictEqual(await hasCacheRow(protectedCode), true);

    // Attempt to bust cache using importerToken
    const response = await refreshHtsCache({ htsCodes: [protectedCode] }, importerToken);
    assert.strictEqual(response.status, 403, 'importer token should be rejected with 403');
    const body = (await response.json()) as RefreshHtsCacheResponse;
    assert.strictEqual(body.error, 'forbidden');

    // Verify row was NOT mutated or removed
    assert.strictEqual(
      await hasCacheRow(protectedCode),
      true,
      'cache row must not be modified or deleted after 403 rejection'
    );
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await refreshHtsCache({ htsCodes: ['0101.01.01'] });
    assert.strictEqual(response.status, 401, 'unauthenticated request should return 401');
    const body = (await response.json()) as RefreshHtsCacheResponse;
    assert.strictEqual(body.error, 'missing bearer token');
  });

  it('rejects invalid body format with 400', async () => {
    const response = await refreshHtsCache({ htsCodes: 'invalid-not-array' }, suretyToken);
    assert.strictEqual(response.status, 400, 'malformed body should return 400');
    const body = (await response.json()) as RefreshHtsCacheResponse;
    assert.strictEqual(body.error, 'invalid input');
    assert.strictEqual(body.target, 'body');
  });
});
