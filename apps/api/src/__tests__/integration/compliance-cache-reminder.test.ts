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
const { bondSignaturesRouter } = await import('../../routes/bond-signatures.js');
const { complianceRouter } = await import('../../routes/compliance.js');

type Role = 'importer' | 'surety_admin';

interface TestUser {
  id: string;
  email: string;
  role: Role;
  token?: string;
}

interface ComplianceFlag {
  id: string;
}

interface Dashboard {
  generatedAt: string;
  totalOpenFlags: number;
  vulnerabilityMetrics: {
    dastScanCoverage: object;
    zeroDayCveExposure: object;
  };
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const app = express();
app.use(express.json());
app.use(bondSignaturesRouter);
app.use('/compliance', complianceRouter);
const server = createServer(app);

let serverUrl: string;
let suretyAdmin: TestUser;
let otherSurety: TestUser;
let importerA: TestUser;
let importerB: TestUser;
let importerAId: string;
let importerBId: string;
let flags: {
  openCriticalImporterA: string;
  openLowImporterB: string;
  resolvedCriticalImporterA: string;
  resolvedHighImporterB: string;
};
let expiredBondId: string;
let recentBondId: string;
let expiredEnvelopeId: string;
let recentEnvelopeId: string;

async function createUser(role: Role, name: string): Promise<TestUser> {
  const email = `${name}-${testTag}@example.com`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, 'integration-test-hash', $2)
     RETURNING id`,
    [email, role]
  );
  const user = { id: result.rows[0]!.id, email, role };
  userIds.push(user.id);
  return user;
}

async function createToken(user: TestUser): Promise<string> {
  const sessionId = await createSession(user.id);
  const token = signToken({ id: user.id, email: user.email, role: user.role, sessionId });
  user.token = token;
  return token;
}

async function createImporter(user: TestUser, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      user.id,
      `${name} ${testTag}`,
      Math.floor(Math.random() * 9_000_000) + 1_000_000,
      `G${randomUUID().replace(/-/g, '').slice(0, 55)}`,
    ]
  );
  return result.rows[0]!.id;
}

async function createFlag(
  suretyId: string,
  importerId: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  resolutionStatus: 'open' | 'resolved'
): Promise<string> {
  const result = await pool.query<ComplianceFlag>(
    `INSERT INTO compliance_flags
       (surety_id, importer_id, flag_type, severity, description, resolution_status)
     VALUES ($1, $2, 'bond_unsigned', $3, 'Integration test flag', $4)
     RETURNING id`,
    [suretyId, importerId, severity, resolutionStatus]
  );
  return result.rows[0]!.id;
}

async function createBond(bondNumber: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO bond_records
       (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
        surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
     VALUES ($1, $2, '02', $3, '12-3456789', 'Integration Surety', '98-7654321',
             500000, 100000, CURRENT_DATE)
     RETURNING id`,
    [importerAId, bondNumber, `Route Test Corp ${testTag}`]
  );
  return result.rows[0]!.id;
}

function authHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    connection: 'close',
  };
}

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, connection: 'close' },
  });
}

async function post(path: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}${path}`, { method: 'POST', headers: authHeaders(token) });
}

async function clearDashboardCache(token: string): Promise<Response> {
  return fetch(`${serverUrl}/compliance/dashboard/cache`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, connection: 'close' },
  });
}

describe('compliance cache, flags, and reminder deadline integration', () => {
  before(async () => {
    suretyAdmin = await createUser('surety_admin', 'routes-surety');
    otherSurety = await createUser('surety_admin', 'routes-other-surety');
    importerA = await createUser('importer', 'routes-importer-a');
    importerB = await createUser('importer', 'routes-importer-b');

    await Promise.all([suretyAdmin, otherSurety, importerA].map(createToken));
    importerAId = await createImporter(importerA, 'Route Test Importer A');
    importerBId = await createImporter(importerB, 'Route Test Importer B');

    flags = {
      openCriticalImporterA: await createFlag(suretyAdmin.id, importerAId, 'critical', 'open'),
      openLowImporterB: await createFlag(suretyAdmin.id, importerBId, 'low', 'open'),
      resolvedCriticalImporterA: await createFlag(
        suretyAdmin.id,
        importerAId,
        'critical',
        'resolved'
      ),
      resolvedHighImporterB: await createFlag(suretyAdmin.id, importerBId, 'high', 'resolved'),
    };
    await createFlag(otherSurety.id, importerAId, 'critical', 'open');

    const bondBase = Math.floor(Math.random() * 9_000_000) + 1_000_000;
    expiredBondId = await createBond(bondBase);
    recentBondId = await createBond(bondBase + 1);
    const expiredSignature = await pool.query<{ envelope_id: string }>(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, status, created_at)
       VALUES ($1, $2, 'sent', now() - INTERVAL '73 hours')
       RETURNING envelope_id`,
      [expiredBondId, `EXPIRED-${testTag}`]
    );
    expiredEnvelopeId = expiredSignature.rows[0]!.envelope_id;
    const recentSignature = await pool.query<{ envelope_id: string }>(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, status, created_at)
       VALUES ($1, $2, 'sent', now() - INTERVAL '71 hours')
       RETURNING envelope_id`,
      [recentBondId, `RECENT-${testTag}`]
    );
    recentEnvelopeId = recentSignature.rows[0]!.envelope_id;

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

  it('caches dashboard responses per surety user and expires the five-minute TTL', async (t) => {
    await clearDashboardCache(suretyAdmin.token!);
    await clearDashboardCache(otherSurety.token!);

    t.mock.timers.enable({ apis: ['Date'], now: new Date() });
    const first = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    const firstBody = (await first.json()) as Dashboard;
    assert.ok(firstBody.vulnerabilityMetrics.dastScanCoverage);
    assert.ok(firstBody.vulnerabilityMetrics.zeroDayCveExposure);

    const second = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    const secondBody = (await second.json()) as Dashboard;
    assert.deepEqual(secondBody, firstBody);
    assert.ok(secondBody.vulnerabilityMetrics.dastScanCoverage);
    assert.ok(secondBody.vulnerabilityMetrics.zeroDayCveExposure);

    const otherFirst = await get('/compliance/dashboard', otherSurety.token!);
    assert.equal(otherFirst.headers.get('x-cache'), 'MISS');
    await otherFirst.arrayBuffer();
    const otherSecond = await get('/compliance/dashboard', otherSurety.token!);
    assert.equal(otherSecond.headers.get('x-cache'), 'HIT');
    await otherSecond.arrayBuffer();

    t.mock.timers.tick(5 * 60 * 1000 + 1);
    const expired = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(expired.headers.get('x-cache'), 'MISS');
    const expiredBody = (await expired.json()) as Dashboard;
    assert.notEqual(expiredBody.generatedAt, firstBody.generatedAt);
    assert.ok(expiredBody.vulnerabilityMetrics.dastScanCoverage);
    assert.ok(expiredBody.vulnerabilityMetrics.zeroDayCveExposure);
  });

  it('invalidates only the caller dashboard cache and recomputes changed data', async () => {
    await clearDashboardCache(suretyAdmin.token!);
    await clearDashboardCache(otherSurety.token!);
    const ownInitialResponse = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(ownInitialResponse.headers.get('x-cache'), 'MISS');
    const otherInitialResponse = await get('/compliance/dashboard', otherSurety.token!);
    assert.equal(otherInitialResponse.headers.get('x-cache'), 'MISS');
    const ownInitial = (await ownInitialResponse.json()) as Dashboard;
    const otherInitial = (await otherInitialResponse.json()) as Dashboard;

    const addedFlag = await createFlag(suretyAdmin.id, importerAId, 'medium', 'open');
    assert.ok(addedFlag);

    const cleared = await clearDashboardCache(suretyAdmin.token!);
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { success: true, message: 'dashboard cache cleared' });

    const recomputed = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(recomputed.headers.get('x-cache'), 'MISS');
    const recomputedBody = (await recomputed.json()) as Dashboard;
    assert.equal(recomputedBody.totalOpenFlags, ownInitial.totalOpenFlags + 1);

    const otherCached = await get('/compliance/dashboard', otherSurety.token!);
    assert.equal(otherCached.headers.get('x-cache'), 'HIT');
    assert.deepEqual(await otherCached.json(), otherInitial);
  });

  it('filters compliance flags and never returns another surety’s rows', async () => {
    async function readFlags(query: string, expectedIds: string[]) {
      const response = await get(`/compliance/flags?${query}`, suretyAdmin.token!);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { flags: ComplianceFlag[]; total: number };
      assert.deepEqual(
        body.flags.map((flag) => flag.id).sort(),
        [...expectedIds].sort()
      );
      assert.equal(body.total, expectedIds.length);
    }

    await readFlags('resolution_status=open', [
      flags.openCriticalImporterA,
      flags.openLowImporterB,
    ]);
    await readFlags('severity=critical', [
      flags.openCriticalImporterA,
      flags.resolvedCriticalImporterA,
    ]);
    await readFlags('severity=critical&resolution_status=resolved', [
      flags.resolvedCriticalImporterA,
    ]);
    await readFlags(`importer_id=${importerAId}`, [
      flags.openCriticalImporterA,
      flags.resolvedCriticalImporterA,
    ]);
    await readFlags(
      `resolution_status=resolved&severity=critical&importer_id=${importerAId}`,
      [flags.resolvedCriticalImporterA]
    );
  });

  it('rejects expired reminders without updating them and allows reminders before the deadline', async () => {
    const importerAttempt = await post(
      `/bonds/${expiredBondId}/send-reminder`,
      importerA.token!
    );
    assert.equal(importerAttempt.status, 403);

    const expired = await post(`/bonds/${expiredBondId}/send-reminder`, suretyAdmin.token!);
    assert.equal(expired.status, 410);
    assert.match((await expired.json()).error, /void and reissue/i);

    const expiredRow = await pool.query<{ last_reminder_sent_at: Date | null }>(
      'SELECT last_reminder_sent_at FROM bond_signatures WHERE envelope_id = $1',
      [expiredEnvelopeId]
    );
    assert.equal(expiredRow.rows[0]?.last_reminder_sent_at, null);

    const recent = await post(`/bonds/${recentBondId}/send-reminder`, suretyAdmin.token!);
    assert.equal(recent.status, 200);
    assert.deepEqual(await recent.json(), { reminded: true, envelopeId: recentEnvelopeId });

    const recentRow = await pool.query<{ last_reminder_sent_at: Date | null }>(
      'SELECT last_reminder_sent_at FROM bond_signatures WHERE envelope_id = $1',
      [recentEnvelopeId]
    );
    assert.ok(recentRow.rows[0]?.last_reminder_sent_at);
  });
});
