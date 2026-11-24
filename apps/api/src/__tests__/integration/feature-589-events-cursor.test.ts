/**
 * Integration coverage for GET /importers/:id/events cursor + limit validation
 * (issue #589).
 *
 * Exercises the real route handler in routes/importers.ts: decodeEventsCursor
 * returning null must surface as a 400 { error: 'invalid cursor' }, and
 * EventsQuerySchema must reject a `limit` outside the 1-100 range. The handler
 * is invoked directly (bypassing authMiddleware) with a surety_admin principal,
 * matching the route/validation-guard pattern used in
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
const importerEmail = `events-cursor-importer-${tag}@example.com`;
const suretyEmail = `events-cursor-surety-${tag}@example.com`;

let importerUserId: string;
let suretyUserId: string;
let importerId: string;
// eventIds[i] is the i-th most recent event (eventIds[0] newest).
const eventIds: string[] = [];
let dbAvailable = false;

/** Invokes the GET /:id/events handler with a surety_admin principal. */
async function callEvents(query: Record<string, string>) {
  const handlers = route('/:id/events', 'get', importersRouter);
  const { res, result } = response();
  await handlers[0](
    { user: { id: suretyUserId, role: 'surety_admin' }, params: { id: importerId }, query },
    res,
    () => undefined
  );
  return result;
}

describe('GET /importers/:id/events cursor and limit validation (#589)', () => {
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
        [importerUserId, `Events Cursor Corp ${tag}`, bondId, `G${tag.toUpperCase()}EVENTSCURSORADDRESS`]
      );
      importerId = importer.rows[0]!.id;

      // Five events, each one minute older than the previous, so keyset
      // ordering on (created_at DESC, id DESC) is deterministic.
      for (let i = 0; i < 5; i++) {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, created_at)
           VALUES ($1, 'deposit_collateral', $2, $3, now() - ($4::int * INTERVAL '1 minute'))
           RETURNING id`,
          [importerId, String(1_000 + i), `cursor-test-tx-${tag}-${i}`, i]
        );
        eventIds.push(inserted.rows[0]!.id);
      }

      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable && importerId) {
      await pool.query('DELETE FROM contract_events WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
    }
    if (dbAvailable && suretyUserId) {
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, suretyUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('rejects a non-base64 cursor with 400 invalid cursor', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const result = await callEvents({ cursor: '!!!not-base64!!!' });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: 'invalid cursor' });
  });

  it("rejects a base64 cursor without a '|' separator with 400 invalid cursor", async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const cursor = Buffer.from('no-separator-here', 'utf8').toString('base64');
    const result = await callEvents({ cursor });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: 'invalid cursor' });
  });

  it('continues to work with a well-formed cursor from a prior response', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const first = await callEvents({ limit: '2' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(
      first.body.data.map((e: any) => e.id),
      [eventIds[0], eventIds[1]]
    );
    assert.equal(typeof first.body.nextCursor, 'string');

    const second = await callEvents({ limit: '2', cursor: first.body.nextCursor });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(
      second.body.data.map((e: any) => e.id),
      [eventIds[2], eventIds[3]]
    );
  });

  it('rejects a limit outside 1-100 with 400 from EventsQuerySchema', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    for (const limit of ['0', '101']) {
      const result = await callEvents({ limit });
      assert.equal(result.statusCode, 400, `limit=${limit} must be rejected`);
      assert.equal(result.body.error, 'invalid input');
      assert.equal(result.body.target, 'query');
      assert.ok(Array.isArray(result.body.details));
    }
  });
});
