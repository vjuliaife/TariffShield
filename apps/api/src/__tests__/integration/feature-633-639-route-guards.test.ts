import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { privacyRouter } from '../../routes/privacy.js';
import { regulatoryRouter } from '../../routes/regulatory.js';
import { suretyLicenseRouter } from '../../routes/surety-license.js';

const tag = randomUUID().slice(0, 8);
const email = `route-guards-${tag}@example.com`;
let userId: string;
let dbAvailable = false;

function route(path: string, method: string, router: any) {
  const layer = router.stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);
  return layer.route.stack;
}

function response() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    send(body: unknown) {
      result.body = body;
      return this;
    },
  };
  return { res, result };
}

describe('route authorization and validation guards (#633, #634, #635, #639)', () => {
  before(async () => {
    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer') RETURNING id`,
        [email, 'integration-test-hash']
      );
      userId = result.rows[0]!.id;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable && userId) {
      await pool.query('DELETE FROM surety_state_licenses WHERE surety_id = $1', [userId]);
      await pool.query('DELETE FROM privacy_policy_acceptances WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('POST /surety-license/submit rejects users without the surety_admin role (#639)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');

    const handlers = route('/submit', 'post', suretyLicenseRouter);
    const { res, result } = response();
    let nextCalled = false;
    await handlers[0]({ user: { id: userId, role: 'importer' } }, res, () => {
      nextCalled = true;
    });

    assert.equal(result.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('GET /api/v1/regulatory/state-report/:state_code rejects reversed dates (#635)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');
    await pool.query(
      `INSERT INTO surety_state_licenses (surety_id, state_code, license_number, expiration_date)
       VALUES ($1, 'CA', $2, CURRENT_DATE + INTERVAL '30 days')`,
      [userId, `LIC-${tag}`]
    );

    const handlers = route('/state-report/:state_code', 'get', regulatoryRouter);
    const { res, result } = response();
    await handlers[0](
      {
        user: { id: userId, role: 'surety_admin' },
        params: { state_code: 'CA' },
        query: { start_date: '2026-12-31', end_date: '2026-01-01' },
      },
      res,
      () => undefined
    );

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: 'start_date must be before or equal to end_date' });
  });

  it('GET /api/v1/regulatory/state-report/:state_code requires an active license (#634)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');
    await pool.query(
      `INSERT INTO surety_state_licenses (surety_id, state_code, license_number, expiration_date)
       VALUES ($1, 'NY', $2, CURRENT_DATE - INTERVAL '1 day')`,
      [userId, `EXPIRED-${tag}`]
    );

    const handlers = route('/state-report/:state_code', 'get', regulatoryRouter);
    const { res, result } = response();
    await handlers[0](
      { user: { id: userId, role: 'surety_admin' }, params: { state_code: 'NY' }, query: {} },
      res,
      () => undefined
    );

    assert.equal(result.statusCode, 403);
    assert.match(String((result.body as { message: string }).message), /active surety license/i);
  });

  it('GET /privacy-policy/current-version returns 404 when no policy exists (#633)', async (t) => {
    if (!dbAvailable) return t.skip('Database not available in this environment');
    await pool.query('DELETE FROM privacy_policy_versions');

    const handlers = route('/current-version', 'get', privacyRouter);
    const { res, result } = response();
    await handlers[0]({}, res, () => undefined);

    assert.equal(result.statusCode, 404);
    assert.deepEqual(result.body, { error: 'no privacy policy published yet' });
  });
});
