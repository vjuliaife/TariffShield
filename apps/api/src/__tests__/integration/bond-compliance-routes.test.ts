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

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const app = express();
app.use(express.json());
app.use(bondSignaturesRouter);
app.use('/compliance', complianceRouter);
const server = createServer(app);

let serverUrl: string;
let suretyAdmin: TestUser;
let importer: TestUser;
let otherSurety: TestUser;
let importerId: string;
let noEnvelopeBondId: string;
let completedEnvelopeBondId: string;
let pendingEnvelopeBondId: string;
let sendSignatureBondId: string;
let pendingEnvelopeId: string;
let ownFlagId: string;
let otherSuretyFlagId: string;

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

async function createBond(bondNumber: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO bond_records
       (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
        surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
     VALUES ($1, $2, '02', $3, '12-3456789', 'Integration Surety', '98-7654321',
             500000, 100000, CURRENT_DATE)
     RETURNING id`,
    [importerId, bondNumber, `Route Test Corp ${testTag}`]
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

async function post(path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, connection: 'close' },
  });
}

describe('bond signature and compliance routes integration (#610, #611, #615, #616)', () => {
  before(async () => {
    suretyAdmin = await createUser('surety_admin', 'routes-surety');
    importer = await createUser('importer', 'routes-importer');
    otherSurety = await createUser('surety_admin', 'routes-other-surety');
    const suretyToken = await createToken(suretyAdmin);
    const importerToken = await createToken(importer);

    const importerResult = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        importer.id,
        `Route Test Importer ${testTag}`,
        Math.floor(Math.random() * 9_000_000) + 1_000_000,
        `G${randomUUID().replace(/-/g, '').slice(0, 55)}`,
      ]
    );
    importerId = importerResult.rows[0]!.id;

    const bondBase = Math.floor(Math.random() * 9_000_000) + 1_000_000;
    noEnvelopeBondId = await createBond(bondBase);
    completedEnvelopeBondId = await createBond(bondBase + 1);
    pendingEnvelopeBondId = await createBond(bondBase + 2);
    sendSignatureBondId = await createBond(bondBase + 3);

    await pool.query(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, status)
       VALUES ($1, $2, 'completed')`,
      [completedEnvelopeBondId, `COMPLETED-${testTag}`]
    );
    await pool.query("UPDATE bond_records SET signature_status = 'completed' WHERE id = $1", [
      completedEnvelopeBondId,
    ]);
    const pendingEnvelope = await pool.query<{ envelope_id: string }>(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, status)
       VALUES ($1, $2, 'sent')
       RETURNING envelope_id`,
      [pendingEnvelopeBondId, `PENDING-${testTag}`]
    );
    pendingEnvelopeId = pendingEnvelope.rows[0]!.envelope_id;
    await pool.query("UPDATE bond_records SET signature_status = 'sent' WHERE id = $1", [
      pendingEnvelopeBondId,
    ]);

    const ownFlag = await pool.query<{ id: string }>(
      `INSERT INTO compliance_flags
         (surety_id, importer_id, flag_type, severity, description)
       VALUES ($1, $2, 'bond_unsigned', 'high', 'Integration test flag')
       RETURNING id`,
      [suretyAdmin.id, importerId]
    );
    ownFlagId = ownFlag.rows[0]!.id;

    const foreignFlag = await pool.query<{ id: string }>(
      `INSERT INTO compliance_flags
         (surety_id, importer_id, flag_type, severity, description)
       VALUES ($1, $2, 'bond_unsigned', 'medium', 'Foreign integration test flag')
       RETURNING id`,
      [otherSurety.id, importerId]
    );
    otherSuretyFlagId = foreignFlag.rows[0]!.id;

    assert.ok(suretyToken);
    assert.ok(importerToken);

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

  it('returns 404 when a bond has no pending sent envelope', async () => {
    for (const bondId of [noEnvelopeBondId, completedEnvelopeBondId, randomUUID()]) {
      const response = await post(`/bonds/${bondId}/send-reminder`, suretyAdmin.token!);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        error: 'no pending envelope found for this bond',
      });
    }
  });

  it('sends a reminder for a pending sent envelope', async () => {
    const response = await post(
      `/bonds/${pendingEnvelopeBondId}/send-reminder`,
      suretyAdmin.token!
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reminded: true, envelopeId: pendingEnvelopeId });

    const reminder = await pool.query<{ reminder_type: string }>(
      `SELECT reminder_type FROM bond_signature_reminders_log
       WHERE bond_record_id = $1 AND envelope_id = $2`,
      [pendingEnvelopeBondId, pendingEnvelopeId]
    );
    assert.equal(reminder.rows[0]?.reminder_type, 'manual');
  });

  it('restricts signature sending and reminders to surety admins', async () => {
    const importerSend = await post(
      `/bonds/${sendSignatureBondId}/send-for-signature`,
      importer.token!
    );
    assert.equal(importerSend.status, 403);

    const adminSend = await post(
      `/bonds/${sendSignatureBondId}/send-for-signature`,
      suretyAdmin.token!
    );
    assert.equal(adminSend.status, 201);

    const importerReminder = await post(
      `/bonds/${pendingEnvelopeBondId}/send-reminder`,
      importer.token!
    );
    assert.equal(importerReminder.status, 403);
  });

  it('keeps signature status available to importers and surety admins', async () => {
    for (const token of [importer.token!, suretyAdmin.token!]) {
      const response = await get(`/bonds/${sendSignatureBondId}/signature-status`, token);
      assert.equal(response.status, 200);
    }
  });

  it('validates resolution notes, records resolution, and invalidates the dashboard cache', async () => {
    const dashboardMiss = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(dashboardMiss.status, 200);
    assert.equal(dashboardMiss.headers.get('x-cache'), 'MISS');
    const dashboardHit = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(dashboardHit.headers.get('x-cache'), 'HIT');

    const shortNote = await post(`/compliance/flags/${ownFlagId}/resolve`, suretyAdmin.token!, {
      resolution_note: 'too short',
    });
    assert.equal(shortNote.status, 400);

    const validNote = 'Reviewed all supporting documents';
    const resolveResponse = await post(
      `/compliance/flags/${ownFlagId}/resolve`,
      suretyAdmin.token!,
      { resolution_note: validNote }
    );
    assert.equal(resolveResponse.status, 200);

    const flag = await pool.query<{
      resolution_status: string;
      resolved_by: string | null;
      resolved_at: Date | null;
      resolution_note: string | null;
    }>(
      `SELECT resolution_status, resolved_by, resolved_at, resolution_note
       FROM compliance_flags WHERE id = $1`,
      [ownFlagId]
    );
    assert.equal(flag.rows[0]?.resolution_status, 'resolved');
    assert.equal(flag.rows[0]?.resolved_by, suretyAdmin.id);
    assert.ok(flag.rows[0]?.resolved_at);
    assert.equal(flag.rows[0]?.resolution_note, validNote);

    const dashboardAfterResolve = await get('/compliance/dashboard', suretyAdmin.token!);
    assert.equal(dashboardAfterResolve.headers.get('x-cache'), 'MISS');

    const repeatedResolve = await post(
      `/compliance/flags/${ownFlagId}/resolve`,
      suretyAdmin.token!,
      { resolution_note: validNote }
    );
    assert.equal(repeatedResolve.status, 404);
  });

  it("does not expose or modify another surety's flag and rejects importers first", async () => {
    const importerAttempt = await post(
      `/compliance/flags/${otherSuretyFlagId}/resolve`,
      importer.token!,
      { resolution_note: 'Reviewed all supporting documents' }
    );
    assert.equal(importerAttempt.status, 403);

    const foreignAttempt = await post(
      `/compliance/flags/${otherSuretyFlagId}/resolve`,
      suretyAdmin.token!,
      { resolution_note: 'Reviewed all supporting documents' }
    );
    assert.equal(foreignAttempt.status, 404);
    assert.deepEqual(await foreignAttempt.json(), {
      error: 'flag not found or already resolved',
    });

    const foreignFlag = await pool.query<{
      resolution_status: string;
      resolved_by: string | null;
      resolved_at: Date | null;
      resolution_note: string | null;
    }>(
      `SELECT resolution_status, resolved_by, resolved_at, resolution_note
       FROM compliance_flags WHERE id = $1`,
      [otherSuretyFlagId]
    );
    assert.deepEqual(foreignFlag.rows[0], {
      resolution_status: 'open',
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
    });
  });
});
