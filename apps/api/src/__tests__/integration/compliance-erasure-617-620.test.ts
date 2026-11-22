/**
 * Integration coverage for compliance-report downloads and data-erasure requests.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

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
const { complianceRouter } = await import('../../routes/compliance.js');
const { erasureRouter } = await import('../../routes/erasure.js');

type Role = 'importer' | 'surety_admin';

interface TestUser {
  id: string;
  email: string;
  role: Role;
  token: string;
}

interface ErasureResponse {
  requestId: string;
  status: string;
  requestedAt: string;
  slaDealineAt: string;
  affectedFields?: string[] | null;
  errorMessage?: string | null;
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const app = express();
app.use(express.json());
app.use('/compliance', complianceRouter);
app.use(erasureRouter);
const server = createServer(app);

let serverUrl: string;
let surety: TestUser;
let otherSurety: TestUser;
let importerWithAccount: TestUser;
let importerWithoutAccount: TestUser;
let importerId: string;
let noPdfReportId: string;
let pdfReportId: string;
let otherSuretyNoPdfReportId: string;
let otherSuretyPdfReportId: string;

async function createUser(role: Role, name: string): Promise<TestUser> {
  const email = `integration-${name}-${testTag}@example.com`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, 'integration-test-hash', $2)
     RETURNING id`,
    [email, role]
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  const sessionId = await createSession(id);
  return {
    id,
    email,
    role,
    token: signToken({ id, email, role, sessionId }),
  };
}

async function createImporter(user: TestUser): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      user.id,
      `Integration Importer ${testTag}`,
      Math.floor(Math.random() * 9_000_000) + 1_000_000,
      `G${randomUUID().replace(/-/g, '').slice(0, 55)}`,
    ]
  );
  return result.rows[0]!.id;
}

async function createReport(suretyId: string, reportMonth: string, pdfKey: string | null) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO compliance_reports (surety_id, report_month, report_data, pdf_s3_key)
     VALUES ($1, $2, '{}'::jsonb, $3)
     RETURNING id`,
    [suretyId, reportMonth, pdfKey]
  );
  return result.rows[0]!.id;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, connection: 'close' };
}

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}${path}`, { headers: authHeaders(token) });
}

async function post(path: string, token: string): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('compliance report and data erasure integration', () => {
  before(async () => {
    surety = await createUser('surety_admin', 'surety');
    otherSurety = await createUser('surety_admin', 'other-surety');
    importerWithAccount = await createUser('importer', 'importer-with-account');
    importerWithoutAccount = await createUser('importer', 'importer-without-account');
    importerId = await createImporter(importerWithAccount);

    noPdfReportId = await createReport(surety.id, '2026-01-01', null);
    pdfReportId = await createReport(surety.id, '2026-02-01', `reports/${testTag}/ready.pdf`);
    otherSuretyNoPdfReportId = await createReport(otherSurety.id, '2026-03-01', null);
    otherSuretyPdfReportId = await createReport(
      otherSurety.id,
      '2026-04-01',
      `reports/${testTag}/other-surety.pdf`
    );

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

  it('#617 returns report PDFs only when available and scoped to the surety', async () => {
    const noPdf = await get(`/compliance/reports/${noPdfReportId}/download`, surety.token);
    assert.equal(noPdf.status, 404);
    assert.deepEqual(await noPdf.json(), { error: 'report PDF not available' });

    const available = await get(`/compliance/reports/${pdfReportId}/download`, surety.token);
    assert.equal(available.status, 200);
    const download = (await available.json()) as {
      url: string;
      expiresInSeconds: number;
    };
    assert.equal(download.url, `/dev/reports/reports/${testTag}/ready.pdf`);
    assert.equal(download.expiresInSeconds, 900);

    for (const reportId of [otherSuretyNoPdfReportId, otherSuretyPdfReportId]) {
      const forbidden = await get(`/compliance/reports/${reportId}/download`, surety.token);
      assert.equal(forbidden.status, 404);
      assert.deepEqual(await forbidden.json(), { error: 'report PDF not available' });
    }

    const listed = await get('/compliance/reports', surety.token);
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as {
      reports: Array<{ id: string; has_pdf: boolean }>;
    };
    assert.deepEqual(
      Object.fromEntries(listBody.reports.map((report) => [report.id, report.has_pdf])),
      { [noPdfReportId]: false, [pdfReportId]: true }
    );
    const otherSuretyReports = await get('/compliance/reports', otherSurety.token);
    assert.equal(otherSuretyReports.status, 200);
    const otherSuretyListBody = (await otherSuretyReports.json()) as {
      reports: Array<{ id: string; has_pdf: boolean }>;
    };
    assert.deepEqual(
      Object.fromEntries(
        otherSuretyListBody.reports.map((report) => [report.id, report.has_pdf])
      ),
      { [otherSuretyNoPdfReportId]: false, [otherSuretyPdfReportId]: true }
    );
    assert.ok(listBody.reports.every((report) => report.id !== otherSuretyPdfReportId));
  });

  it('#618 creates erasure requests with optional importer linkage and SLA fields', async () => {
    for (const [user, expectedImporterId] of [
      [importerWithAccount, importerId],
      [importerWithoutAccount, null],
    ] as const) {
      const response = await post('/account/erasure-request', user.token);
      assert.equal(response.status, 202);
      const body = (await response.json()) as ErasureResponse;
      assert.ok(body.requestId);
      assert.equal(body.status, 'pending');
      assert.ok(body.requestedAt);
      assert.ok(body.slaDealineAt);

      const row = await pool.query<{ importer_id: string | null }>(
        'SELECT importer_id FROM data_erasure_requests WHERE request_id = $1 AND user_id = $2',
        [body.requestId, user.id]
      );
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0]?.importer_id, expectedImporterId);
    }
  });

  it('#620 returns clean 404 responses for unknown or malformed request IDs', async () => {
    for (const requestId of [randomUUID(), 'not-a-uuid']) {
      const response = await get(
        `/account/erasure-request/${requestId}`,
        importerWithAccount.token
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'request not found' });
    }
  });

  it('#619 scopes erasure requests to their owner and returns status details', async () => {
    const created = await post('/account/erasure-request', importerWithAccount.token);
    assert.equal(created.status, 202);
    const createdBody = (await created.json()) as ErasureResponse;

    const immediate = await get(
      `/account/erasure-request/${createdBody.requestId}`,
      importerWithAccount.token
    );
    assert.equal(immediate.status, 200);
    const initialBody = (await immediate.json()) as ErasureResponse;
    assert.equal(initialBody.requestId, createdBody.requestId);
    assert.equal(initialBody.status, 'pending');

    const foreign = await get(
      `/account/erasure-request/${createdBody.requestId}`,
      importerWithoutAccount.token
    );
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { error: 'request not found' });

    await pool.query(
      `UPDATE data_erasure_requests
       SET status = 'completed', completed_at = now(),
           affected_fields = ARRAY['legal_name', 'ein']
       WHERE request_id = $1`,
      [createdBody.requestId]
    );
    const completed = await get(
      `/account/erasure-request/${createdBody.requestId}`,
      importerWithAccount.token
    );
    assert.equal(completed.status, 200);
    const completedBody = (await completed.json()) as ErasureResponse;
    assert.equal(completedBody.status, 'completed');
    assert.deepEqual(completedBody.affectedFields, ['legal_name', 'ein']);
    assert.equal(completedBody.errorMessage, null);

    const failedRequest = await post('/account/erasure-request', importerWithAccount.token);
    const failedRequestBody = (await failedRequest.json()) as ErasureResponse;
    await pool.query(
      `UPDATE data_erasure_requests
       SET status = 'failed', error_message = 'Integration test failure'
       WHERE request_id = $1`,
      [failedRequestBody.requestId]
    );
    const failed = await get(
      `/account/erasure-request/${failedRequestBody.requestId}`,
      importerWithAccount.token
    );
    assert.equal(failed.status, 200);
    const failedBody = (await failed.json()) as ErasureResponse;
    assert.equal(failedBody.status, 'failed');
    assert.equal(failedBody.errorMessage, 'Integration test failure');
  });
});
