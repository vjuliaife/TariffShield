/**
 * Integration test suite for GET /admin/oracle-feed and GET /admin/oracle-feed/export.csv.
 *
 * Covers:
 * - #601: GET /admin/oracle-feed applies importer_id/from/to filters with correct pagination totals
 * - #602: GET /admin/oracle-feed/export.csv produces correctly escaped CSV rows (RFC 4180)
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

interface OracleFeedRow {
  id: string;
  importer_id: string | null;
  importer_address: string;
  required_collateral: string;
  previous_collateral: string;
  pct_change: string;
  tx_hash: string;
  ledger_sequence: number;
  set_by: string;
  emergency_override: boolean;
  created_at: string;
}

interface OracleFeedResponse {
  data: OracleFeedRow[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
  error?: string;
  target?: string;
  details?: unknown[];
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const importerIds: string[] = [];
const feedIds: string[] = [];

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const server = createServer(app);

let serverUrl: string;
let suretyToken: string;
let importerToken: string;
let importerAId: string;
let importerBId: string;
let dbAvailable = false;

// Seeded feed row IDs for assertions
let feedA1Id: string;
let feedA2Id: string;
let feedA3Id: string;
let feedB1Id: string;
let feedB2Id: string;

async function getOracleFeed(
  token?: string,
  query?: Record<string, string | number>
): Promise<Response> {
  const url = new URL(`${serverUrl}/admin/oracle-feed`);
  if (query) {
    for (const [key, val] of Object.entries(query)) {
      url.searchParams.set(key, String(val));
    }
  }
  const headers: Record<string, string> = { connection: 'close' };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(url.toString(), {
    method: 'GET',
    headers,
  });
}

async function exportOracleFeedCsv(
  token?: string,
  query?: Record<string, string | number>
): Promise<Response> {
  const url = new URL(`${serverUrl}/admin/oracle-feed/export.csv`);
  if (query) {
    for (const [key, val] of Object.entries(query)) {
      url.searchParams.set(key, String(val));
    }
  }
  const headers: Record<string, string> = { connection: 'close' };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(url.toString(), {
    method: 'GET',
    headers,
  });
}

describe('admin oracle-feed routes integration (#601, #602)', () => {
  before(async () => {
    try {
      await pool.query('SELECT 1');
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }

    // 1. Create surety_admin user and session
    const surety = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'surety_admin')
       RETURNING id, email`,
      [`surety-feed-${testTag}@example.com`, 'test-hash-not-real']
    );
    const suretyUser = surety.rows[0]!;
    userIds.push(suretyUser.id);
    const suretySession = await createSession(suretyUser.id);
    suretyToken = signToken({
      id: suretyUser.id,
      email: suretyUser.email,
      role: 'surety_admin',
      sessionId: suretySession,
    });

    // 2. Create importer user A and session
    const importerAUser = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id, email`,
      [`importer-feed-a-${testTag}@example.com`, 'test-hash-not-real']
    );
    const uA = importerAUser.rows[0]!;
    userIds.push(uA.id);
    const impSession = await createSession(uA.id);
    importerToken = signToken({
      id: uA.id,
      email: uA.email,
      role: 'importer',
      sessionId: impSession,
    });

    const impARec = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        uA.id,
        `Oracle Feed Corp A ${testTag}`,
        Math.floor(Math.random() * 9_000_000) + 1_000_000,
        `GA${randomUUID().replace(/-/g, '').slice(0, 54)}`,
      ]
    );
    importerAId = impARec.rows[0]!.id;
    importerIds.push(importerAId);

    // 3. Create importer user B and record
    const importerBUser = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id, email`,
      [`importer-feed-b-${testTag}@example.com`, 'test-hash-not-real']
    );
    const uB = importerBUser.rows[0]!;
    userIds.push(uB.id);

    const impBRec = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        uB.id,
        `Oracle Feed Corp B ${testTag}`,
        Math.floor(Math.random() * 9_000_000) + 1_000_000,
        `GB${randomUUID().replace(/-/g, '').slice(0, 54)}`,
      ]
    );
    importerBId = impBRec.rows[0]!.id;
    importerIds.push(importerBId);

    // 4. Seed oracle_price_feed rows with distinct timestamps and importers
    // Importer A rows:
    // A1: 2026-06-01T10:00:00Z
    const a1 = await pool.query<{ id: string }>(
      `INSERT INTO oracle_price_feed
         (importer_id, importer_address, required_collateral, previous_collateral, pct_change,
          tx_hash, ledger_sequence, set_by, emergency_override, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        importerAId,
        'GA_TEST_STELLAR_ADDR_A1',
        '100000.0000000',
        '0.0000000',
        '0.0000',
        `0xa1${randomUUID().replace(/-/g, '').slice(0, 60)}`,
        1001,
        'admin_a1',
        false,
        '2026-06-01T10:00:00Z',
      ]
    );
    feedA1Id = a1.rows[0]!.id;
    feedIds.push(feedA1Id);

    // A2: 2026-06-05T12:00:00Z (contains comma in set_by: "oracle,operator")
    const a2 = await pool.query<{ id: string }>(
      `INSERT INTO oracle_price_feed
         (importer_id, importer_address, required_collateral, previous_collateral, pct_change,
          tx_hash, ledger_sequence, set_by, emergency_override, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        importerAId,
        'GA_TEST_STELLAR_ADDR_A2',
        '200000.0000000',
        '100000.0000000',
        '100.0000',
        `0xa2${randomUUID().replace(/-/g, '').slice(0, 60)}`,
        1002,
        'oracle,operator',
        false,
        '2026-06-05T12:00:00Z',
      ]
    );
    feedA2Id = a2.rows[0]!.id;
    feedIds.push(feedA2Id);

    // A3: 2026-06-10T14:00:00Z (contains double quote in set_by: 'oracle"special')
    const a3 = await pool.query<{ id: string }>(
      `INSERT INTO oracle_price_feed
         (importer_id, importer_address, required_collateral, previous_collateral, pct_change,
          tx_hash, ledger_sequence, set_by, emergency_override, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        importerAId,
        'GA_TEST_STELLAR_ADDR_A3',
        '300000.0000000',
        '200000.0000000',
        '50.0000',
        `0xa3${randomUUID().replace(/-/g, '').slice(0, 60)}`,
        1003,
        'oracle"special',
        true,
        '2026-06-10T14:00:00Z',
      ]
    );
    feedA3Id = a3.rows[0]!.id;
    feedIds.push(feedA3Id);

    // Importer B rows:
    // B1: 2026-06-03T11:00:00Z
    const b1 = await pool.query<{ id: string }>(
      `INSERT INTO oracle_price_feed
         (importer_id, importer_address, required_collateral, previous_collateral, pct_change,
          tx_hash, ledger_sequence, set_by, emergency_override, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        importerBId,
        'GB_TEST_STELLAR_ADDR_B1',
        '150000.0000000',
        '0.0000000',
        '0.0000',
        `0xb1${randomUUID().replace(/-/g, '').slice(0, 60)}`,
        1004,
        'admin_b1',
        false,
        '2026-06-03T11:00:00Z',
      ]
    );
    feedB1Id = b1.rows[0]!.id;
    feedIds.push(feedB1Id);

    // B2: 2026-06-15T15:00:00Z
    const b2 = await pool.query<{ id: string }>(
      `INSERT INTO oracle_price_feed
         (importer_id, importer_address, required_collateral, previous_collateral, pct_change,
          tx_hash, ledger_sequence, set_by, emergency_override, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        importerBId,
        'GB_TEST_STELLAR_ADDR_B2',
        '250000.0000000',
        '150000.0000000',
        '66.6667',
        `0xb2${randomUUID().replace(/-/g, '').slice(0, 60)}`,
        1005,
        'admin_b2',
        false,
        '2026-06-15T15:00:00Z',
      ]
    );
    feedB2Id = b2.rows[0]!.id;
    feedIds.push(feedB2Id);

    // 5. Start Express HTTP server
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
    if (dbAvailable) {
      if (feedIds.length) {
        await pool.query('DELETE FROM oracle_price_feed WHERE id = ANY($1::uuid[])', [feedIds]);
      }
      if (importerIds.length) {
        await pool.query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [importerIds]);
      }
      if (userIds.length) {
        await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await pool.end();
    }
  });

  // =========================================================================
  // #601: GET /admin/oracle-feed filtering and pagination
  // =========================================================================
  describe('Issue #601 — GET /admin/oracle-feed query filters and pagination', () => {
    it('importer_id filter returns only that importer’s oracle_price_feed rows', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      const res = await getOracleFeed(suretyToken, { importer_id: importerAId });
      assert.strictEqual(res.status, 200, 'must return 200 for surety_admin');
      const body = (await res.json()) as OracleFeedResponse;

      assert.strictEqual(body.pagination.total, 3, 'importer A total must be exactly 3');
      assert.strictEqual(body.data.length, 3, 'should return 3 rows for importer A');
      for (const row of body.data) {
        assert.strictEqual(
          row.importer_id,
          importerAId,
          'all returned rows must belong to importer A'
        );
      }

      // Verify importer B rows are excluded
      const bRowFound = body.data.some((r) => r.id === feedB1Id || r.id === feedB2Id);
      assert.strictEqual(bRowFound, false, 'importer B rows must not be present');
    });

    it('from/to date range filter excludes rows outside the window', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      // Filter between June 2 and June 6 (should match A2 on June 5 and B1 on June 3)
      const res = await getOracleFeed(suretyToken, {
        from: '2026-06-02T00:00:00Z',
        to: '2026-06-06T23:59:59Z',
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as OracleFeedResponse;

      assert.strictEqual(body.pagination.total, 2, 'window June 2-6 must contain exactly 2 rows');
      const returnedIds = body.data.map((r) => r.id);
      assert.ok(returnedIds.includes(feedA2Id), 'feed A2 (June 5) must be included');
      assert.ok(returnedIds.includes(feedB1Id), 'feed B1 (June 3) must be included');

      // Out-of-window rows must be excluded
      assert.strictEqual(
        returnedIds.includes(feedA1Id),
        false,
        'feed A1 (June 1) must be excluded (before "from")'
      );
      assert.strictEqual(
        returnedIds.includes(feedA3Id),
        false,
        'feed A3 (June 10) must be excluded (after "to")'
      );
      assert.strictEqual(
        returnedIds.includes(feedB2Id),
        false,
        'feed B2 (June 15) must be excluded (after "to")'
      );
    });

    it('total and total_pages in pagination reflect the filtered count, not the full table', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      // Importer A has 3 rows. With per_page = 2, total_pages should be ceil(3 / 2) = 2.
      const page1Res = await getOracleFeed(suretyToken, {
        importer_id: importerAId,
        page: 1,
        per_page: 2,
      });
      assert.strictEqual(page1Res.status, 200);
      const page1Body = (await page1Res.json()) as OracleFeedResponse;

      assert.strictEqual(page1Body.pagination.total, 3, 'total must reflect filtered count of 3');
      assert.strictEqual(page1Body.pagination.page, 1, 'page must be 1');
      assert.strictEqual(page1Body.pagination.per_page, 2, 'per_page must be 2');
      assert.strictEqual(page1Body.pagination.total_pages, 2, 'total_pages must be ceil(3/2) = 2');
      assert.strictEqual(page1Body.data.length, 2, 'page 1 must contain 2 rows');

      // Fetch page 2
      const page2Res = await getOracleFeed(suretyToken, {
        importer_id: importerAId,
        page: 2,
        per_page: 2,
      });
      assert.strictEqual(page2Res.status, 200);
      const page2Body = (await page2Res.json()) as OracleFeedResponse;

      assert.strictEqual(page2Body.pagination.total, 3, 'page 2 total must also be 3');
      assert.strictEqual(page2Body.pagination.page, 2, 'page must be 2');
      assert.strictEqual(page2Body.pagination.total_pages, 2, 'total_pages must be 2');
      assert.strictEqual(page2Body.data.length, 1, 'page 2 must contain remaining 1 row');
    });

    it('per_page above 200 or page below 1 returns 400 from OracleFeedQuerySchema', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      // 1. per_page > 200
      const resHighPerPage = await getOracleFeed(suretyToken, { per_page: 201 });
      assert.strictEqual(resHighPerPage.status, 400, 'per_page > 200 must return 400');
      const bodyHigh = (await resHighPerPage.json()) as OracleFeedResponse;
      assert.strictEqual(bodyHigh.error, 'invalid input');
      assert.strictEqual(bodyHigh.target, 'query');

      // 2. page < 1 (0)
      const resZeroPage = await getOracleFeed(suretyToken, { page: 0 });
      assert.strictEqual(resZeroPage.status, 400, 'page 0 must return 400');
      const bodyZero = (await resZeroPage.json()) as OracleFeedResponse;
      assert.strictEqual(bodyZero.error, 'invalid input');
      assert.strictEqual(bodyZero.target, 'query');

      // 3. negative page (-5)
      const resNegPage = await getOracleFeed(suretyToken, { page: -5 });
      assert.strictEqual(resNegPage.status, 400, 'negative page must return 400');
    });
  });

  // =========================================================================
  // #602: GET /admin/oracle-feed/export.csv escaping and formatting
  // =========================================================================
  describe('Issue #602 — GET /admin/oracle-feed/export.csv RFC 4180 escaping and ordering', () => {
    it('Response Content-Type is text/csv and Content-Disposition names a dated filename', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      const res = await exportOracleFeedCsv(suretyToken, { importer_id: importerAId });
      assert.strictEqual(res.status, 200, 'export.csv must return 200');

      const contentType = res.headers.get('content-type') ?? '';
      assert.ok(
        contentType.includes('text/csv'),
        `Content-Type must be text/csv, received: ${contentType}`
      );

      const contentDisp = res.headers.get('content-disposition') ?? '';
      const expectedDate = new Date().toISOString().slice(0, 10);
      assert.ok(
        contentDisp.includes('attachment;'),
        'Content-Disposition must specify attachment'
      );
      assert.ok(
        contentDisp.includes(`filename="oracle_price_feed_${expectedDate}.csv"`),
        `Content-Disposition must name dated filename oracle_price_feed_${expectedDate}.csv, received: ${contentDisp}`
      );
    });

    it('A field containing a comma is wrapped in double quotes in the output', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      const res = await exportOracleFeedCsv(suretyToken, { importer_id: importerAId });
      const csvText = await res.text();

      // Row A2 has set_by = 'oracle,operator'
      // RFC 4180 / CSV row builder produces: "oracle,operator"
      assert.ok(
        csvText.includes('"oracle,operator"'),
        'field containing a comma must be wrapped in double quotes ("oracle,operator")'
      );
    });

    it('A field containing a double quote is escaped as two double quotes', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      const res = await exportOracleFeedCsv(suretyToken, { importer_id: importerAId });
      const csvText = await res.text();

      // Row A3 has set_by = 'oracle"special'
      // Escaped per RFC 4180: "oracle""special"
      assert.ok(
        csvText.includes('"oracle""special"'),
        'field containing a double quote must escape it as two double quotes ("oracle""special")'
      );
    });

    it('Rows are ordered created_at ASC (oldest first), the opposite of the paginated JSON endpoint', async (t) => {
      if (!dbAvailable) return t?.skip('Database not available');

      // 1. In JSON endpoint: ordered created_at DESC (newest first: A3 -> A2 -> A1)
      const jsonRes = await getOracleFeed(suretyToken, { importer_id: importerAId });
      const jsonBody = (await jsonRes.json()) as OracleFeedResponse;
      const jsonIds = jsonBody.data.map((r) => r.id);
      assert.deepStrictEqual(
        jsonIds,
        [feedA3Id, feedA2Id, feedA1Id],
        'JSON endpoint must be ordered created_at DESC (newest first)'
      );

      // 2. In CSV export: ordered created_at ASC (oldest first: A1 -> A2 -> A3)
      const csvRes = await exportOracleFeedCsv(suretyToken, { importer_id: importerAId });
      const csvText = await csvRes.text();
      const lines = csvText.trim().split('\n');

      // Line 0 is header
      assert.strictEqual(
        lines[0],
        'id,importer_id,importer_address,required_collateral,previous_collateral,pct_change,tx_hash,ledger_sequence,set_by,emergency_override,created_at'
      );

      // Lines 1, 2, 3 should correspond to A1, A2, A3 in order
      assert.ok(lines[1]!.includes(feedA1Id), 'first data row in CSV must be A1 (oldest)');
      assert.ok(lines[2]!.includes(feedA2Id), 'second data row in CSV must be A2 (middle)');
      assert.ok(lines[3]!.includes(feedA3Id), 'third data row in CSV must be A3 (newest)');

      // Verify created_at timestamps are ascending
      const indexA1 = csvText.indexOf(feedA1Id);
      const indexA2 = csvText.indexOf(feedA2Id);
      const indexA3 = csvText.indexOf(feedA3Id);
      assert.ok(
        indexA1 < indexA2 && indexA2 < indexA3,
        'CSV rows must appear in chronological ascending order (A1 < A2 < A3)'
      );
    });
  });
});
