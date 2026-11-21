/**
 * Integration coverage for the surety-license and regulatory-report routes.
 *
 * Run with a migrated PostgreSQL test database via:
 *   npm run test:integration --workspace=apps/api
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';
const pool = new Pool({ connectionString: DATABASE_URL });
const tag = randomUUID().slice(0, 8);

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

function routeHandler(router: any, path: string, method: string, stackIndex = 0) {
  const layer = (router.stack as any[]).find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} route must be registered`);
  const handlerIndex = stackIndex < 0 ? layer.route.stack.length + stackIndex : stackIndex;
  return layer.route.stack[handlerIndex].handle;
}

async function createUser(role: string, suffix: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3) RETURNING id`,
    [`integration-${suffix}-${tag}@example.com`, 'integration-test-hash', role]
  );
  return result.rows[0]!.id;
}

describe('surety-license and regulatory route regressions', () => {
  let suretyId: string;
  let importerId: string;
  let verificationId: string;

  before(async () => {
    suretyId = await createUser('surety_admin', 'surety');
    importerId = await createUser('importer', 'importer');

    const verification = await pool.query<{ id: string }>(
      `INSERT INTO surety_license_verifications (user_id, status)
       VALUES ($1, 'submitted') RETURNING id`,
      [suretyId]
    );
    verificationId = verification.rows[0]!.id;

    await pool.query(
      `INSERT INTO surety_state_licenses (surety_id, state_code, license_number)
       VALUES ($1, $2, $3)`,
      [suretyId, `T${tag.slice(0, 1).toUpperCase()}`, `LIC-${tag}`]
    );
  });

  after(async () => {
    await pool.query('DELETE FROM regulatory_report_audit_logs WHERE surety_id = $1', [suretyId]);
    await pool.query('DELETE FROM surety_state_licenses WHERE surety_id = $1', [suretyId]);
    await pool.query('DELETE FROM surety_license_verifications WHERE user_id = $1', [suretyId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [suretyId, importerId]);
    await pool.end();
  });

  it('#641 documents that an authenticated importer can review a license until platform_admin lands', async () => {
    const { suretyLicenseRouter } = await import('../../routes/surety-license.js');
    const review = routeHandler(suretyLicenseRouter, '/:id/review', 'put');
    const { res, captured } = response();

    await review(
      {
        params: { id: verificationId },
        body: { action: 'approve' },
        user: { id: importerId, role: 'importer' },
      },
      res,
      () => undefined
    );

    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, { id: verificationId, status: 'verified' });

    const rejected = await pool.query(
      `UPDATE surety_license_verifications SET status = 'submitted' WHERE id = $1 RETURNING id`,
      [verificationId]
    );
    assert.equal(rejected.rowCount, 1);

    const second = response();
    await review(
      {
        params: { id: verificationId },
        body: { action: 'reject', rejectionReason: 'integration rejection' },
        user: { id: importerId, role: 'importer' },
      },
      second.res,
      () => undefined
    );
    assert.equal(second.captured.statusCode, 200);
    const row = await pool.query(
      'SELECT status, rejection_reason FROM surety_license_verifications WHERE id = $1',
      [verificationId]
    );
    assert.deepEqual(row.rows[0], { status: 'rejected', rejection_reason: 'integration rejection' });

    const missing = response();
    await review(
      {
        params: { id: randomUUID() },
        body: { action: 'approve' },
        user: { id: importerId, role: 'importer' },
      },
      missing.res,
      () => undefined
    );
    assert.equal(missing.captured.statusCode, 404);
  });

  it('#640 returns 404 and does not create a verification row when submit has no record', async () => {
    const userId = await createUser('surety_admin', 'no-verification');
    try {
      const { suretyLicenseRouter } = await import('../../routes/surety-license.js');
      const submit = routeHandler(suretyLicenseRouter, '/submit', 'post', -1);
      const { res, captured } = response();

      await submit(
        {
          body: { naicNumber: '12345', companyName: 'No Record Co', stateOfDomicile: 'CA' },
          user: { id: userId, role: 'surety_admin' },
        },
        res,
        () => undefined
      );

      assert.equal(captured.statusCode, 404);
      const rows = await pool.query(
        'SELECT id FROM surety_license_verifications WHERE user_id = $1',
        [userId]
      );
      assert.equal(rows.rowCount, 0);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  it('#636 and #637 cache JSON/CSV reports and audit only cache misses', async () => {
    const { regulatoryRouter } = await import('../../routes/regulatory.js');
    const handler = routeHandler(regulatoryRouter, '/state-report/:state_code', 'get');
    const stateCode = `T${tag.slice(0, 1).toUpperCase()}`;
    const query = { start_date: '2026-01-01', end_date: '2026-01-31' };

    const jsonFirst = response();
    await handler({ params: { state_code: stateCode }, query: { ...query, format: 'json' }, user: { id: suretyId, role: 'surety_admin', email: 'test@example.com' } }, jsonFirst.res);
    assert.equal(jsonFirst.captured.statusCode, 200);
    assert.equal(jsonFirst.captured.headers['x-cache'], 'MISS');
    const jsonSecond = response();
    await handler({ params: { state_code: stateCode }, query: { ...query, format: 'json' }, user: { id: suretyId, role: 'surety_admin', email: 'test@example.com' } }, jsonSecond.res);
    assert.equal(jsonSecond.captured.headers['x-cache'], 'HIT');
    assert.deepEqual(jsonSecond.captured.body, jsonFirst.captured.body);

    const csvFirst = response();
    await handler({ params: { state_code: stateCode }, query: { ...query, format: 'csv' }, user: { id: suretyId, role: 'surety_admin', email: 'test@example.com' } }, csvFirst.res);
    assert.equal(csvFirst.captured.headers['x-cache'], 'MISS');
    assert.match(csvFirst.captured.headers['content-type'], /^text\/csv/);
    assert.match(csvFirst.captured.headers['content-disposition'], /filename="regulatory_report_/);
    const csvSecond = response();
    await handler({ params: { state_code: stateCode }, query: { ...query, format: 'csv' }, user: { id: suretyId, role: 'surety_admin', email: 'test@example.com' } }, csvSecond.res);
    assert.equal(csvSecond.captured.headers['x-cache'], 'HIT');
    assert.equal(csvSecond.captured.body, csvFirst.captured.body);

    const audits = await pool.query(
      `SELECT surety_id, state_code, start_date::text, end_date::text, output_format
         FROM regulatory_report_audit_logs
        WHERE surety_id = $1 AND state_code = $2
        ORDER BY output_format`,
      [suretyId, stateCode]
    );
    assert.deepEqual(audits.rows, [
      { surety_id: suretyId, state_code: stateCode, start_date: '2026-01-01', end_date: '2026-01-31', output_format: 'csv' },
      { surety_id: suretyId, state_code: stateCode, start_date: '2026-01-01', end_date: '2026-01-31', output_format: 'json' },
    ]);
  });
});
