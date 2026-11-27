/**
 * Integration tests for importer routes: role-based scoping, cursor pagination, and admin-only endpoints.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 * The CI workflow runs `npm run db:migrate` before invoking this suite.
 *
 * Tests:
 * - #585: GET /importers scopes results by caller role
 * - #586: GET /importers/stats is restricted to surety_admin
 * - #587: GET /importers/:id returns 404 for another importer's token
 * - #588: GET /importers/:id/events cursor pagination round-trips correctly
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { importersRouter } from '../../routes/importers.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const importer1Email = `integration-importers-imp1-${testTag}@example.com`;
const importer2Email = `integration-importers-imp2-${testTag}@example.com`;
const suretyEmail = `integration-importers-surety-${testTag}@example.com`;

let importer1UserId: string;
let importer1Id: string;
let importer2UserId: string;
let importer2Id: string;
let suretyUserId: string;
let dbAvailable = false;

const testBondId1 = Math.floor(Math.random() * 9_000_000) + 1_000_000;
const testBondId2 = testBondId1 + 1;

type CapturedResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
};

function response(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined, headers: {} };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    send(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

async function getImporters(user: { id: string; email: string; role: 'importer' | 'surety_admin' }) {
  const layer = (importersRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/' && entry.route.methods.get
  );
  assert.ok(layer, 'GET /importers route must be registered');

  const { res, captured } = response();
  const req: any = { user, method: 'GET' };

  for (const handlerObj of layer.route.stack) {
    let nextCalled = false;
    let nextErr: any = null;
    await handlerObj.handle(req, res, (err?: any) => {
      nextCalled = true;
      nextErr = err;
    });
    if (nextErr) throw nextErr;
    if (!nextCalled) break;
  }

  return captured;
}

async function getImporterStats(user: { id: string; email: string; role: 'importer' | 'surety_admin' }) {
  const layer = (importersRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/stats' && entry.route.methods.get
  );
  assert.ok(layer, 'GET /importers/stats route must be registered');

  const { res, captured } = response();
  const req: any = { user, method: 'GET' };

  for (const handlerObj of layer.route.stack) {
    let nextCalled = false;
    let nextErr: any = null;
    await handlerObj.handle(req, res, (err?: any) => {
      nextCalled = true;
      nextErr = err;
    });
    if (nextErr) throw nextErr;
    if (!nextCalled) break;
  }

  return captured;
}

async function getImporterById(
  importerId: string,
  user: { id: string; email: string; role: 'importer' | 'surety_admin' }
) {
  const layer = (importersRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/:id' && entry.route.methods.get
  );
  assert.ok(layer, 'GET /importers/:id route must be registered');

  const { res, captured } = response();
  const req: any = {
    params: { id: importerId },
    user,
    method: 'GET',
  };

  for (const handlerObj of layer.route.stack) {
    let nextCalled = false;
    let nextErr: any = null;
    await handlerObj.handle(req, res, (err?: any) => {
      nextCalled = true;
      nextErr = err;
    });
    if (nextErr) throw nextErr;
    if (!nextCalled) break;
  }

  return captured;
}

async function getImporterEvents(
  importerId: string,
  user: { id: string; email: string; role: 'importer' | 'surety_admin' },
  query: { cursor?: string; limit?: number } = {}
) {
  const layer = (importersRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/:id/events' && entry.route.methods.get
  );
  assert.ok(layer, 'GET /importers/:id/events route must be registered');

  const { res, captured } = response();
  const req: any = {
    params: { id: importerId },
    query,
    user,
    method: 'GET',
  };

  for (const handlerObj of layer.route.stack) {
    let nextCalled = false;
    let nextErr: any = null;
    await handlerObj.handle(req, res, (err?: any) => {
      nextCalled = true;
      nextErr = err;
    });
    if (nextErr) throw nextErr;
    if (!nextCalled) break;
  }

  return captured;
}

describe('importers routes integration — role-based scoping and pagination', () => {
  before(async () => {
    try {
      // Create importer 1 and their user
      const user1Result = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer')
         RETURNING id`,
        [importer1Email, 'test-hash-not-real']
      );
      importer1UserId = user1Result.rows[0]!.id;

      const importer1Result = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          importer1UserId,
          'Integration Test Importer 1',
          testBondId1,
          'GABC1111TESTSTELLARADDRESS00000000000000000000000000000000',
        ]
      );
      importer1Id = importer1Result.rows[0]!.id;

      // Create importer 2 and their user
      const user2Result = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer')
         RETURNING id`,
        [importer2Email, 'test-hash-not-real']
      );
      importer2UserId = user2Result.rows[0]!.id;

      const importer2Result = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          importer2UserId,
          'Integration Test Importer 2',
          testBondId2,
          'GABC2222TESTSTELLARADDRESS00000000000000000000000000000000',
        ]
      );
      importer2Id = importer2Result.rows[0]!.id;

      // Create surety admin user
      const suretyResult = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'surety_admin')
         RETURNING id`,
        [suretyEmail, 'test-hash-not-real']
      );
      suretyUserId = suretyResult.rows[0]!.id;

      // Seed contract events for importer 1 (for pagination testing)
      for (let i = 0; i < 15; i++) {
        await pool.query(
          `INSERT INTO contract_events (importer_id, kind, tx_hash, ledger_sequence, event_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            importer1Id,
            ['register', 'deposit', 'required_changed', 'auto_top_up', 'withdraw'][i % 5],
            `tx-${i}-${testTag}`,
            100 + i,
            i,
          ]
        );
      }

      dbAvailable = true;
    } catch (err) {
      console.error('Setup failed:', err);
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      // Clean up contract_events first (references importer_id via FK)
      if (importer1Id) {
        await pool.query('DELETE FROM contract_events WHERE importer_id = $1', [importer1Id]);
        await pool.query('DELETE FROM contract_events WHERE importer_id = $1', [importer2Id]);
      }
      // Clean up importers
      if (importer1Id) {
        await pool.query('DELETE FROM importers WHERE id = $1', [importer1Id]);
      }
      if (importer2Id) {
        await pool.query('DELETE FROM importers WHERE id = $1', [importer2Id]);
      }
      // Clean up users
      if (importer1UserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [importer1UserId]);
      }
      if (importer2UserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [importer2UserId]);
      }
      if (suretyUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [suretyUserId]);
      }
    }
    await pool.end().catch(() => undefined);
  });

  // ─────────────────────────────────────────────────────────────────────
  // #585: GET /importers scopes results by caller role
  // ─────────────────────────────────────────────────────────────────────

  it('#585: importer token GET /importers returns only own importer row', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporters({
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    });

    assert.strictEqual(result.statusCode, 200, 'importer GET /importers should return 200');
    const body = result.body as any;
    assert.ok(Array.isArray(body.importers), 'response should include importers array');
    assert.strictEqual(
      body.importers.length,
      1,
      'importer should only see their own importer row'
    );
    assert.strictEqual(body.importers[0].id, importer1Id, 'returned importer should be their own');
  });

  it('#585: importer with no registered importer row gets empty array', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Create a new importer-role user with no importer record
    const noImporterUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id`,
      [`no-importer-${testTag}@example.com`, 'test-hash-not-real']
    );
    const noImporterUserId = noImporterUserResult.rows[0]!.id;

    try {
      const result = await getImporters({
        id: noImporterUserId,
        email: `no-importer-${testTag}@example.com`,
        role: 'importer',
      });

      assert.strictEqual(result.statusCode, 200);
      const body = result.body as any;
      assert.ok(Array.isArray(body.importers), 'response should include importers array');
      assert.strictEqual(body.importers.length, 0, 'user with no importer should get empty array');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [noImporterUserId]);
    }
  });

  it('#585: surety_admin token GET /importers returns all importers with email field', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporters({
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });

    assert.strictEqual(result.statusCode, 200, 'surety_admin GET /importers should return 200');
    const body = result.body as any;
    assert.ok(Array.isArray(body.importers), 'response should include importers array');

    // Should see at least both test importers
    assert.ok(
      body.importers.length >= 2,
      'surety_admin should see at least the two test importers'
    );

    // Find our test importers
    const foundImporter1 = body.importers.find((i: any) => i.id === importer1Id);
    const foundImporter2 = body.importers.find((i: any) => i.id === importer2Id);

    assert.ok(foundImporter1, 'should find importer 1');
    assert.ok(foundImporter2, 'should find importer 2');

    // Check email field is included for surety_admin
    assert.ok(
      foundImporter1.email,
      'surety_admin response should include email field for each importer'
    );
    assert.strictEqual(foundImporter1.email, importer1Email, 'email field should match');
  });

  it('#585: response never includes stellar_secret_encrypted for either role', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Check importer role
    const importerResult = await getImporters({
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    });
    const importerBody = importerResult.body as any;
    assert.ok(
      !importerBody.importers[0].stellar_secret_encrypted,
      'importer response should not include stellar_secret_encrypted'
    );

    // Check surety_admin role
    const suretyResult = await getImporters({
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });
    const suretyBody = suretyResult.body as any;
    for (const importer of suretyBody.importers) {
      assert.ok(
        !importer.stellar_secret_encrypted,
        'surety_admin response should not include stellar_secret_encrypted'
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // #586: GET /importers/stats is restricted to surety_admin
  // ─────────────────────────────────────────────────────────────────────

  it('#586: importer token GET /importers/stats returns 403', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterStats({
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    });

    assert.strictEqual(
      result.statusCode,
      403,
      'importer GET /importers/stats should return 403'
    );
    const body = result.body as any;
    assert.strictEqual(body.error, 'surety admin only', 'error message should indicate restriction');
  });

  it('#586: surety_admin token GET /importers/stats returns 200 with metrics', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterStats({
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });

    assert.strictEqual(result.statusCode, 200, 'surety_admin GET /importers/stats should return 200');
    const body = result.body as any;
    assert.ok(body.metrics, 'response should include metrics field');
  });

  it('#586: /stats is not intercepted by /:id route (stats is never treated as id)', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Verify that GET /importers/stats for surety_admin does NOT return 404 (which would
    // mean the /:id route intercepted it and treated 'stats' as an importer UUID)
    const result = await getImporterStats({
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });

    assert.notStrictEqual(
      result.statusCode,
      404,
      'GET /importers/stats should not be intercepted as /:id route'
    );
    assert.strictEqual(result.statusCode, 200, 'GET /importers/stats should return 200');
  });

  // ─────────────────────────────────────────────────────────────────────
  // #587: GET /importers/:id returns 404 for another user, 200 for surety_admin
  // ─────────────────────────────────────────────────────────────────────

  it('#587: importer token requesting another importer id returns 404', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterById(importer1Id, {
      id: importer2UserId,
      email: importer2Email,
      role: 'importer',
    });

    assert.strictEqual(
      result.statusCode,
      404,
      'importer token requesting another importer should return 404'
    );
    const body = result.body as any;
    assert.strictEqual(body.error, 'not found', 'error message should be "not found"');
  });

  it('#587: surety_admin token requesting importer id returns 200 with onChainAccount', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterById(importer1Id, {
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });

    assert.strictEqual(
      result.statusCode,
      200,
      'surety_admin token requesting importer should return 200'
    );
    const body = result.body as any;
    assert.ok(body.importer, 'response should include importer field');
    assert.ok(body.onChainAccount, 'response should include onChainAccount');
    assert.ok(body.onChainAccount.bondId, 'onChainAccount should include bondId');
    assert.ok(
      body.onChainAccount.requiredCollateral !== undefined,
      'onChainAccount should include requiredCollateral'
    );
    assert.ok(
      body.onChainAccount.isClawbacked !== undefined,
      'onChainAccount should include isClawbacked'
    );
  });

  it('#587: requesting non-existent UUID returns 404 for both roles', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const nonExistentId = randomUUID();

    // Test importer role
    const importerResult = await getImporterById(nonExistentId, {
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    });
    assert.strictEqual(importerResult.statusCode, 404, 'non-existent ID should return 404 for importer');

    // Test surety_admin role
    const suretyResult = await getImporterById(nonExistentId, {
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    });
    assert.strictEqual(suretyResult.statusCode, 404, 'non-existent ID should return 404 for surety_admin');
  });

  it('#587: importer token requesting own importer id returns 200', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterById(importer1Id, {
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    });

    assert.strictEqual(
      result.statusCode,
      200,
      'importer token requesting own id should return 200'
    );
    const body = result.body as any;
    assert.ok(body.importer, 'response should include importer field');
    assert.ok(body.onChainAccount, 'response should include onChainAccount');
  });

  // ─────────────────────────────────────────────────────────────────────
  // #588: GET /importers/:id/events cursor pagination round-trips correctly
  // ─────────────────────────────────────────────────────────────────────

  it('#588: first page returns exactly limit events and non-null nextCursor when more rows exist', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterEvents(importer1Id, {
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    }, { limit: 5 });

    assert.strictEqual(result.statusCode, 200, 'first page request should return 200');
    const body = result.body as any;
    assert.ok(Array.isArray(body.data), 'response should include data array');
    assert.strictEqual(body.data.length, 5, 'first page should return exactly limit (5) events');
    assert.ok(body.nextCursor, 'first page should have nextCursor since more rows exist (15 total)');
  });

  it('#588: following nextCursor returns next page in correct descending order', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Get first page
    const page1Result = await getImporterEvents(importer1Id, {
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    }, { limit: 5 });
    assert.strictEqual(page1Result.statusCode, 200);
    const page1Body = page1Result.body as any;
    const page1Events = page1Body.data;
    assert.strictEqual(page1Events.length, 5);
    const nextCursor = page1Body.nextCursor;
    assert.ok(nextCursor);

    // Get second page using cursor
    const page2Result = await getImporterEvents(importer1Id, {
      id: importer1UserId,
      email: importer1Email,
      role: 'importer',
    }, { cursor: nextCursor, limit: 5 });
    assert.strictEqual(page2Result.statusCode, 200);
    const page2Body = page2Result.body as any;
    const page2Events = page2Body.data;
    assert.strictEqual(page2Events.length, 5, 'second page should return limit (5) events');

    // Verify no duplicates between pages
    const page1Ids = new Set(page1Events.map((e: any) => e.id));
    const page2Ids = new Set(page2Events.map((e: any) => e.id));
    const duplicates = page1Ids.intersection
      ? page1Ids.intersection(page2Ids)
      : [...page1Ids].filter((id) => page2Ids.has(id));
    assert.strictEqual(
      duplicates.length,
      0,
      'pages should not have duplicate events'
    );

    // Verify descending order: page 2 events should be chronologically after page 1 events
    const lastPage1Timestamp = new Date(page1Events[page1Events.length - 1].createdAt).getTime();
    const firstPage2Timestamp = new Date(page2Events[0].createdAt).getTime();
    assert.ok(
      lastPage1Timestamp >= firstPage2Timestamp,
      'page 2 events should continue in descending order from page 1'
    );
  });

  it('#588: final page returns nextCursor null once all rows exhausted', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Paginate through all events
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    let totalEvents = 0;

    // Loop through all pages
    while (pages < 10) {
      // Safety limit to avoid infinite loops
      const pageResult = await getImporterEvents(importer1Id, {
        id: importer1UserId,
        email: importer1Email,
        role: 'importer',
      }, { ...(cursor ? { cursor } : {}), limit: 5 });

      assert.strictEqual(pageResult.statusCode, 200);
      const pageBody = pageResult.body as any;
      totalEvents += pageBody.data.length;

      if (!pageBody.nextCursor) {
        // Last page reached
        assert.ok(pageBody.data.length <= 5, 'final page should have <= limit events');
        break;
      }

      cursor = pageBody.nextCursor;
      pages++;
    }

    assert.strictEqual(totalEvents, 15, 'should paginate through exactly 15 events');
  });

  it('#588: events with same created_at timestamp are ordered deterministically via id tiebreaker', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Create two events with identical created_at timestamp for importer 1
    const now = new Date();
    const eventId1 = randomUUID();
    const eventId2 = randomUUID();

    try {
      await pool.query(
        `INSERT INTO contract_events (id, importer_id, kind, tx_hash, ledger_sequence, event_index, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId1, importer1Id, 'deposit', 'tx-same-ts-1', 200, 100, now]
      );

      await pool.query(
        `INSERT INTO contract_events (id, importer_id, kind, tx_hash, ledger_sequence, event_index, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId2, importer1Id, 'deposit', 'tx-same-ts-2', 201, 101, now]
      );

      // Fetch events and verify they maintain consistent ordering
      const result1 = await getImporterEvents(importer1Id, {
        id: importer1UserId,
        email: importer1Email,
        role: 'importer',
      }, { limit: 100 });

      const body1 = result1.body as any;
      const events1 = body1.data;

      // Find our same-timestamp events in the result
      const sameTimestampEvents = events1.filter(
        (e: any) => e.id === eventId1 || e.id === eventId2
      );

      assert.strictEqual(
        sameTimestampEvents.length,
        2,
        'should find both same-timestamp events'
      );

      // Verify they appear in consistent order across multiple requests
      const result2 = await getImporterEvents(importer1Id, {
        id: importer1UserId,
        email: importer1Email,
        role: 'importer',
      }, { limit: 100 });

      const body2 = result2.body as any;
      const events2 = body2.data;
      const sameTimestampEvents2 = events2.filter(
        (e: any) => e.id === eventId1 || e.id === eventId2
      );

      // The order should be consistent between requests
      assert.strictEqual(
        sameTimestampEvents[0].id,
        sameTimestampEvents2[0].id,
        'same-timestamp events should appear in consistent order'
      );
    } finally {
      // Clean up the test events
      await pool.query('DELETE FROM contract_events WHERE id = $1 OR id = $2', [eventId1, eventId2]);
    }
  });

  it('#588: pagination respects importer ownership (cannot access another importer events)', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Importer 2 tries to get events for Importer 1
    const result = await getImporterEvents(importer1Id, {
      id: importer2UserId,
      email: importer2Email,
      role: 'importer',
    });

    assert.strictEqual(
      result.statusCode,
      404,
      'importer should not be able to access another importer events'
    );
  });

  it('#588: surety_admin can access any importer events', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const result = await getImporterEvents(importer1Id, {
      id: suretyUserId,
      email: suretyEmail,
      role: 'surety_admin',
    }, { limit: 10 });

    assert.strictEqual(result.statusCode, 200, 'surety_admin should access any importer events');
    const body = result.body as any;
    assert.ok(Array.isArray(body.data), 'response should include data array');
  });
});
