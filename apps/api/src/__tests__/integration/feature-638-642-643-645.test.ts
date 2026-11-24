import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test',
});
const tag = randomUUID().slice(0, 8);

type Captured = { statusCode: number; body: unknown };

function response(): { res: Record<string, (...args: never[]) => unknown>; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    send(body: unknown) {
      captured.body = body;
      return res;
    },
    setHeader() {
      return res;
    },
  } as Record<string, (...args: never[]) => unknown>;
  return { res, captured };
}

function handler(
  router: {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (...args: never[]) => unknown }>;
      };
    }>;
  },
  path: string,
  method: string
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer?.route, `${method.toUpperCase()} ${path} must be registered`);
  return layer.route.stack.at(-1)!.handle;
}

async function createUser(role: 'importer' | 'surety_admin') {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
    [`feature-${role}-${randomUUID()}@example.com`, 'integration-test-hash', role]
  );
  return result.rows[0]!.id;
}

describe('surety license, ToS and regulatory report integrations', () => {
  const createdUsers: string[] = [];

  before(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end();
      throw error;
    }
  });

  after(async () => {
    if (createdUsers.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]);
    }
    await pool.end();
  });

  it('filters GET /surety-license by status (#643)', async () => {
    const { suretyLicenseRouter } = await import('../../routes/surety-license.js');
    const submitted = await createUser('surety_admin');
    const pending = await createUser('surety_admin');
    createdUsers.push(submitted, pending);
    await pool.query(
      `INSERT INTO surety_license_verifications (user_id, status, company_name, state_of_domicile)
       VALUES ($1, 'submitted', 'Submitted Co', 'CA'), ($2, 'pending', 'Pending Co', 'NY')`,
      [submitted, pending]
    );

    const { res, captured } = response();
    await handler(suretyLicenseRouter as never, '/', 'get')(
      { query: { status: 'submitted' } },
      res,
      () => undefined
    );
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(
      (captured.body as { verifications: Array<{ status: string }> }).verifications.map(
        (v) => v.status
      ),
      ['submitted']
    );
  });

  it('returns 404 when accepting an unknown ToS version (#645)', async () => {
    const { tosRouter } = await import('../../routes/tos.js');
    const userId = await createUser('importer');
    createdUsers.push(userId);
    const { res, captured } = response();
    await handler(tosRouter as never, '/accept-tos', 'post')(
      { body: { versionId: `missing-${tag}` }, user: { id: userId } },
      res,
      () => undefined
    );
    assert.equal(captured.statusCode, 404);
    assert.deepEqual(captured.body, { error: 'ToS version not found' });
  });

  it('returns 404 for license status before a submission exists (#642)', async () => {
    const { suretyLicenseRouter } = await import('../../routes/surety-license.js');
    const userId = await createUser('surety_admin');
    createdUsers.push(userId);
    const { res, captured } = response();
    await handler(suretyLicenseRouter as never, '/status', 'get')(
      { user: { id: userId, role: 'surety_admin' } },
      res,
      () => undefined
    );
    assert.equal(captured.statusCode, 404);
    assert.deepEqual(captured.body, { error: 'no license verification record found' });
  });

  it('aggregates bonds, claims and collateral once per underlying record (#638)', async () => {
    const { regulatoryRouter } = await import('../../routes/regulatory.js');
    const suretyId = await createUser('surety_admin');
    const importerId = await createUser('importer');
    createdUsers.push(suretyId, importerId);
    const state = `T${tag.slice(0, 1).toUpperCase()}`;
    await pool.query(
      `INSERT INTO surety_state_licenses (surety_id, state_code, license_number)
       VALUES ($1, $2, $3)`,
      [suretyId, state, `LIC-${tag}`]
    );
    await pool.query(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, collateral_balance, business_state)
       VALUES ($1, 'Fixture Importer', $2, $3, 700, 'CA')`,
      [importerId, Number(`9${tag.replace(/\D/g, '') || '1'}`), `G${tag}`]
    );
    const importer = await pool.query<{ id: string }>(
      'SELECT id FROM importers WHERE user_id = $1',
      [importerId]
    );
    const internalImporterId = importer.rows[0]!.id;
    await pool.query(
      `INSERT INTO bond_records
        (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein, surety_company_name,
         surety_fein, bond_amount, cbp_minimum_required, effective_date, state_code)
       VALUES
        ($1, 1001, '01', 'Fixture Importer', 'EIN-1', 'Fixture Surety', 'FEIN-1', 1000, 500, CURRENT_DATE, $2),
        ($1, 1002, '02', 'Fixture Importer', 'EIN-1', 'Fixture Surety', 'FEIN-1', 2000, 500, CURRENT_DATE, $2)`,
      [internalImporterId, state]
    );
    await pool.query(
      `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, created_at)
       VALUES ($1, 'clawback', 100, $2, CURRENT_DATE + INTERVAL '12 hours')`,
      [internalImporterId, `tx-${tag}`]
    );

    const { res, captured } = response();
    await handler(regulatoryRouter as never, '/state-report/:state_code', 'get')(
      {
        params: { state_code: state },
        query: { start_date: '2026-01-01', end_date: '2026-12-31' },
        user: { id: suretyId, role: 'surety_admin' },
      },
      res,
      () => undefined
    );
    assert.equal(captured.statusCode, 200);
    const stats = (captured.body as { stats: Record<string, unknown> }).stats;
    assert.equal(stats.totalBondsWritten, 2);
    assert.equal(stats.aggregateFaceValue, '3000');
    assert.equal(stats.claimsFiled, 1);
    assert.equal(stats.collateralHeldOnChain, '700');
  });
});
