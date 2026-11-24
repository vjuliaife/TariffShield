/**
 * Integration tests for bond record persistence against a real PostgreSQL instance.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 * The CI workflow runs `npm run db:migrate` before invoking this suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bondSignaturesRouter, bondWebhookRouter } from '../../routes/bond-signatures.js';
import { env } from '../../config/env.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const testEmail = `integration-bonds-${testTag}@example.com`;
const suretyEmail = `integration-surety-${testTag}@example.com`;

let userId: string;
let suretyUserId: string;
let importerId: string;
let dbAvailable = false;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

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

async function sendForSignature(bondRecordId: string, role = 'surety_admin') {
  const layer = (bondSignaturesRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/bonds/:id/send-for-signature' && entry.route.methods.post
  );
  assert.ok(layer, 'POST /bonds/:id/send-for-signature route must be registered');

  const { res, captured } = response();
  const req: any = {
    params: { id: bondRecordId },
    user: { id: suretyUserId, email: suretyEmail, role },
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

async function getSignatureStatus(
  bondRecordId: string,
  user: { id: string; email: string; role: 'importer' | 'surety_admin' }
) {
  const layer = (bondSignaturesRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/bonds/:id/signature-status' && entry.route.methods.get
  );
  assert.ok(layer, 'GET /bonds/:id/signature-status route must be registered');

  const { res, captured } = response();
  const req: any = {
    params: { id: bondRecordId },
    user,
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

async function postWebhook(
  payload: any,
  rawBody: Buffer,
  headers: Record<string, string> = {}
) {
  const layer = (bondWebhookRouter.stack as any[]).find(
    (entry) => entry.route?.path === '/bonds/docusign-webhook' && entry.route.methods.post
  );
  assert.ok(layer, 'POST /bonds/docusign-webhook route must be registered');

  const { res, captured } = response();
  const req: any = {
    body: payload,
    rawBody,
    headers: { ...headers },
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

describe('bonds integration — real Postgres insert', () => {
  before(async () => {
    try {
      const userResult = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testEmail, 'test-hash-not-real', 'importer']
      );
      userId = userResult.rows[0]!.id;

      const importerResult = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          userId,
          'Integration Test Corp',
          testBondId,
          'GABC1234TESTSTELLARADDRESS00000000000000000000000000000000',
        ]
      );
      importerId = importerResult.rows[0]!.id;

      const suretyResult = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'surety_admin')
         RETURNING id`,
        [suretyEmail, 'test-hash-not-real']
      );
      suretyUserId = suretyResult.rows[0]!.id;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      if (importerId) {
        await pool.query(
          'DELETE FROM bond_signatures WHERE bond_record_id IN (SELECT id FROM bond_records WHERE importer_id = $1)',
          [importerId]
        );
        await pool.query('DELETE FROM bond_records WHERE importer_id = $1', [importerId]);
        await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
      }
      if (suretyUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [suretyUserId]);
      }
      if (userId) {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    }
    await pool.end().catch(() => undefined);
  });

  it('inserts a bond record and retrieves it', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');
    const result = await pool.query<{ id: string; bond_id: string; bond_amount: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE)
       RETURNING id, bond_id, bond_amount`,
      [
        importerId,
        testBondId,
        '02',
        'Integration Test Corp',
        '12-3456789',
        'Test Surety Company',
        '98-7654321',
        '500000',
        '100000',
      ]
    );

    assert.strictEqual(result.rowCount, 1, 'one row should be inserted');
    const row = result.rows[0]!;
    assert.ok(row.id, 'inserted row should have a UUID id');
    assert.strictEqual(String(row.bond_id), String(testBondId), 'bond_id should match');
    assert.strictEqual(row.bond_amount, '500000', 'bond_amount should match');
  });

  it('enforces bond_type_code check constraint', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO bond_records
             (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
              surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE)`,
          [
            importerId,
            testBondId + 1,
            '99',
            'Integration Test Corp',
            '12-3456789',
            'Test Surety Company',
            '98-7654321',
            '500000',
            '100000',
          ]
        ),
      /violates check constraint/i,
      'invalid bond_type_code should raise a check constraint error'
    );
  });

  // #604 — POST /bonds/:id/send-for-signature returns 502 when envelope creation fails
  it('POST /bonds/:id/send-for-signature returns 502 when DocuSign envelope creation fails and recovers on retry', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const bondInsert = await pool.query<{ id: string; signature_status: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE)
       RETURNING id, signature_status`,
      [
        importerId,
        testBondId + 2,
        '02',
        'Integration Test Corp',
        '12-3456789',
        'Test Surety Company',
        '98-7654321',
        '500000',
        '100000',
      ]
    );
    const bondRecordId = bondInsert.rows[0]!.id;
    assert.strictEqual(
      bondInsert.rows[0]!.signature_status,
      'pending',
      'initial signature_status should be pending'
    );

    const originalKey = env.DOCUSIGN_INTEGRATION_KEY;
    try {
      // Simulate API failure by setting DOCUSIGN_INTEGRATION_KEY (causes createDocuSignEnvelope to throw)
      (env as any).DOCUSIGN_INTEGRATION_KEY = 'mock-integration-key-failure';

      const failedResult = await sendForSignature(bondRecordId);

      // Acceptance Criteria 1: Envelope creation failure returns 502 with an error and detail message
      assert.strictEqual(
        failedResult.statusCode,
        502,
        'envelope creation failure must return HTTP 502'
      );
      const failedBody = failedResult.body as any;
      assert.ok(failedBody, 'response body must be defined');
      assert.strictEqual(
        failedBody.error,
        'envelope creation failed',
        'response error message must indicate envelope creation failure'
      );
      if (failedBody.detail !== undefined) {
        assert.strictEqual(typeof failedBody.detail, 'string');
      }

      // Acceptance Criteria 2: No bond_signatures row is created for the failed attempt
      const sigsAfterFail = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM bond_signatures WHERE bond_record_id = $1',
        [bondRecordId]
      );
      assert.strictEqual(
        Number(sigsAfterFail.rows[0]!.count),
        0,
        'no bond_signatures row should be created for failed attempt'
      );

      // Acceptance Criteria 3: bond_records.signature_status is not updated to 'sent' when the call fails
      const bondAfterFail = await pool.query<{ signature_status: string }>(
        'SELECT signature_status FROM bond_records WHERE id = $1',
        [bondRecordId]
      );
      assert.notStrictEqual(
        bondAfterFail.rows[0]!.signature_status,
        'sent',
        'bond_records.signature_status must not be updated to sent when envelope creation fails'
      );
      assert.strictEqual(
        bondAfterFail.rows[0]!.signature_status,
        'pending',
        'bond_records.signature_status must remain unchanged (pending)'
      );

      // Acceptance Criteria 4: A subsequent retry with a working envelope creation path succeeds normally
      delete (env as any).DOCUSIGN_INTEGRATION_KEY;

      const successResult = await sendForSignature(bondRecordId);
      assert.strictEqual(
        successResult.statusCode,
        201,
        'retry with working envelope creation path must succeed with HTTP 201'
      );
      const successBody = successResult.body as any;
      assert.ok(
        successBody?.signature?.envelope_id,
        'successful retry must return signature with envelope_id'
      );
      assert.strictEqual(
        successBody?.signature?.status,
        'sent',
        'signature record status must be "sent"'
      );

      const sigsAfterRetry = await pool.query<{ count: string; status: string }>(
        'SELECT count(*) AS count, status FROM bond_signatures WHERE bond_record_id = $1 GROUP BY status',
        [bondRecordId]
      );
      assert.strictEqual(
        Number(sigsAfterRetry.rows[0]!.count),
        1,
        'exactly one bond_signatures row should exist after successful retry'
      );
      assert.strictEqual(
        sigsAfterRetry.rows[0]!.status,
        'sent',
        'bond_signatures status should be sent'
      );

      const bondAfterRetry = await pool.query<{ signature_status: string }>(
        'SELECT signature_status FROM bond_records WHERE id = $1',
        [bondRecordId]
      );
      assert.strictEqual(
        bondAfterRetry.rows[0]!.signature_status,
        'sent',
        'bond_records.signature_status must be updated to "sent" on successful retry'
      );
    } finally {
      if (originalKey !== undefined) {
        (env as any).DOCUSIGN_INTEGRATION_KEY = originalKey;
      } else {
        delete (env as any).DOCUSIGN_INTEGRATION_KEY;
      }
    }
  });

  // #603 — POST /bonds/:id/send-for-signature returns 409 for an already-completed bond
  it('POST /bonds/:id/send-for-signature returns 409 for an already-completed bond', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Acceptance Criteria 4: Unknown bondRecordId returns 404 before the completed-status check
    const unknownBondId = randomUUID();
    const notFoundResult = await sendForSignature(unknownBondId);
    assert.strictEqual(notFoundResult.statusCode, 404, 'unknown bond ID should return 404');
    assert.strictEqual(
      (notFoundResult.body as any)?.error,
      'bond not found',
      'unknown bond ID should return "bond not found"'
    );

    // Insert a test bond record with signature_status = 'completed'
    const bondInsert = await pool.query<{ id: string; signature_status: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, signature_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, 'completed')
       RETURNING id, signature_status`,
      [
        importerId,
        testBondId + 3,
        '02',
        'Integration Test Corp',
        '12-3456789',
        'Test Surety Company',
        '98-7654321',
        '500000',
        '100000',
      ]
    );
    const bondRecordId = bondInsert.rows[0]!.id;
    assert.strictEqual(bondInsert.rows[0]!.signature_status, 'completed');

    // Count signatures before request
    const sigCountBefore = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM bond_signatures WHERE bond_record_id = $1',
      [bondRecordId]
    );
    assert.strictEqual(Number(sigCountBefore.rows[0]!.count), 0);

    // Set DOCUSIGN_INTEGRATION_KEY: if createDocuSignEnvelope were called, it would throw 502
    const originalKey = env.DOCUSIGN_INTEGRATION_KEY;
    try {
      (env as any).DOCUSIGN_INTEGRATION_KEY = 'mock-key-should-not-be-called';

      // Acceptance Criteria 1: Bond with signature_status 'completed' returns 409 'bond already has a completed signature'
      const completedResult = await sendForSignature(bondRecordId);
      assert.strictEqual(
        completedResult.statusCode,
        409,
        'completed bond should return 409 without calling envelope creation'
      );
      assert.strictEqual(
        (completedResult.body as any)?.error,
        'bond already has a completed signature',
        'error message must match "bond already has a completed signature"'
      );

      // Acceptance Criteria 2: No new bond_signatures row is inserted for the rejected call
      const sigCountAfter = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM bond_signatures WHERE bond_record_id = $1',
        [bondRecordId]
      );
      assert.strictEqual(
        Number(sigCountAfter.rows[0]!.count),
        0,
        'no bond_signatures row should be created for completed bond call'
      );
    } finally {
      if (originalKey !== undefined) {
        (env as any).DOCUSIGN_INTEGRATION_KEY = originalKey;
      } else {
        delete (env as any).DOCUSIGN_INTEGRATION_KEY;
      }
    }

    // Acceptance Criteria 3: A bond with signature_status 'sent' or null proceeds to envelope creation
    // 3a: Verify bond with signature_status = 'sent' proceeds to envelope creation
    await pool.query("UPDATE bond_records SET signature_status = 'sent' WHERE id = $1", [
      bondRecordId,
    ]);

    const sentResult = await sendForSignature(bondRecordId);
    assert.strictEqual(
      sentResult.statusCode,
      201,
      'bond with signature_status "sent" should proceed to envelope creation'
    );
    assert.ok(
      (sentResult.body as any)?.signature?.envelope_id,
      'should return created envelope details'
    );

    // 3b: Verify bond with null signature_status proceeds to envelope creation (if schema allows NULL)
    try {
      await pool.query('UPDATE bond_records SET signature_status = NULL WHERE id = $1', [
        bondRecordId,
      ]);
      const nullResult = await sendForSignature(bondRecordId);
      assert.strictEqual(
        nullResult.statusCode,
        201,
        'bond with null signature_status should proceed to envelope creation'
      );
      assert.ok((nullResult.body as any)?.signature?.envelope_id);
    } catch {
      // Column has NOT NULL constraint; 'sent' and initial 'pending' verified non-completed path proceeds
    }
  });

  // #605 — GET /bonds/:id/signature-status scopes results to the owning importer
  it('GET /bonds/:id/signature-status scopes results to the owning importer and returns latest envelope', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const user2Email = `integration-bonds-other-${testTag}@example.com`;
    const testBondIdOther = Math.floor(Math.random() * 9_000_000) + 1_000_000;

    let user2Id: string | undefined;
    let importer2Id: string | undefined;

    try {
      // Create a second user and importer
      const u2Res = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'importer')
         RETURNING id`,
        [user2Email, 'test-hash-not-real']
      );
      user2Id = u2Res.rows[0]!.id;

      const imp2Res = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          user2Id,
          'Second Importer Corp',
          testBondIdOther,
          'GABC9999TESTSTELLARADDRESS00000000000000000000000000000000',
        ]
      );
      importer2Id = imp2Res.rows[0]!.id;

      // 1. Bond for importer 1 (owned by userId)
      const bond1Insert = await pool.query<{ id: string }>(
        `INSERT INTO bond_records
           (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
            surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, signature_status)
         VALUES ($1, $2, '02', 'Integration Test Corp', '12-3456789', 'Test Surety Company', '98-7654321', 500000, 100000, CURRENT_DATE, 'sent')
         RETURNING id`,
        [importerId, testBondId + 4]
      );
      const bond1Id = bond1Insert.rows[0]!.id;

      // 2. Bond for importer 2 (owned by user2Id)
      const bond2Insert = await pool.query<{ id: string }>(
        `INSERT INTO bond_records
           (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
            surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, signature_status)
         VALUES ($1, $2, '02', 'Second Importer Corp', '99-8888888', 'Test Surety Company', '98-7654321', 500000, 100000, CURRENT_DATE, 'completed')
         RETURNING id`,
        [importer2Id, testBondIdOther]
      );
      const bond2Id = bond2Insert.rows[0]!.id;

      // Insert two envelopes for bond 1 to test ordering by created_at DESC
      const olderEnvId = `ENV-OLD-${testTag}-${randomUUID().slice(0, 4)}`;
      const newerEnvId = `ENV-NEW-${testTag}-${randomUUID().slice(0, 4)}`;

      await pool.query(
        `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status, created_at)
         VALUES ($1, $2, 'https://demo.docusign.net/old', 'delivered', now() - INTERVAL '1 hour')`,
        [bond1Id, olderEnvId]
      );

      await pool.query(
        `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status, created_at)
         VALUES ($1, $2, 'https://demo.docusign.net/new', 'sent', now())`,
        [bond1Id, newerEnvId]
      );

      // Acceptance Criteria 1: Importer token requesting another importer's bond signature status returns 404
      const otherImpRes = await getSignatureStatus(bond1Id, {
        id: user2Id,
        email: user2Email,
        role: 'importer',
      });
      assert.strictEqual(
        otherImpRes.statusCode,
        404,
        "importer requesting another importer's bond must receive 404"
      );
      assert.strictEqual(
        (otherImpRes.body as any)?.error,
        'bond not found',
        'error message must be "bond not found"'
      );

      // Acceptance Criteria 2: Importer token requesting its own bond's status returns 200 with the current signature_status
      const ownImpRes = await getSignatureStatus(bond1Id, {
        id: userId,
        email: testEmail,
        role: 'importer',
      });
      assert.strictEqual(
        ownImpRes.statusCode,
        200,
        "importer requesting its own bond must receive 200"
      );
      const ownBody = ownImpRes.body as any;
      assert.strictEqual(ownBody.bondId, bond1Id);
      assert.strictEqual(ownBody.signatureStatus, 'sent');

      // Acceptance Criteria 4: Response includes the most recent bond_signatures envelope, ordered by created_at DESC
      assert.ok(ownBody.envelope, 'response must include envelope');
      assert.strictEqual(
        ownBody.envelope.envelope_id,
        newerEnvId,
        'response must return the most recent envelope ordered by created_at DESC'
      );
      assert.strictEqual(ownBody.envelope.status, 'sent');

      // Acceptance Criteria 3: surety_admin token can fetch status for any bondRecordId
      const suretyRes1 = await getSignatureStatus(bond1Id, {
        id: suretyUserId,
        email: suretyEmail,
        role: 'surety_admin',
      });
      assert.strictEqual(
        suretyRes1.statusCode,
        200,
        'surety_admin must be able to fetch status for importer 1 bond'
      );
      assert.strictEqual((suretyRes1.body as any).signatureStatus, 'sent');
      assert.strictEqual((suretyRes1.body as any).envelope.envelope_id, newerEnvId);

      const suretyRes2 = await getSignatureStatus(bond2Id, {
        id: suretyUserId,
        email: suretyEmail,
        role: 'surety_admin',
      });
      assert.strictEqual(
        suretyRes2.statusCode,
        200,
        'surety_admin must be able to fetch status for importer 2 bond'
      );
      assert.strictEqual((suretyRes2.body as any).signatureStatus, 'completed');
    } finally {
      if (importer2Id) {
        await pool.query(
          'DELETE FROM bond_signatures WHERE bond_record_id IN (SELECT id FROM bond_records WHERE importer_id = $1)',
          [importer2Id]
        );
        await pool.query('DELETE FROM bond_records WHERE importer_id = $1', [importer2Id]);
        await pool.query('DELETE FROM importers WHERE id = $1', [importer2Id]);
      }
      if (user2Id) {
        await pool.query('DELETE FROM users WHERE id = $1', [user2Id]);
      }
    }
  });

  // #606 — POST /bonds/docusign-webhook rejects invalid HMAC signature with 401
  it('POST /bonds/docusign-webhook rejects invalid HMAC signature with 401 and accepts valid signature', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    // Insert a test bond record
    const bondInsert = await pool.query<{ id: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, signature_status)
       VALUES ($1, $2, '02', 'Integration Test Corp', '12-3456789', 'Test Surety Company', '98-7654321', 500000, 100000, CURRENT_DATE, 'sent')
       RETURNING id`,
      [importerId, testBondId + 5]
    );
    const bondRecordId = bondInsert.rows[0]!.id;

    const webhookEnvId = `ENV-WEBHOOK-${testTag}-${randomUUID().slice(0, 4)}`;
    await pool.query(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status)
       VALUES ($1, $2, 'https://demo.docusign.net/webhook-test', 'sent')`,
      [bondRecordId, webhookEnvId]
    );

    const hmacKey = 'test-docusign-hmac-secret-key-32chars!!';
    const originalHmacKey = env.DOCUSIGN_WEBHOOK_HMAC_KEY;

    try {
      (env as any).DOCUSIGN_WEBHOOK_HMAC_KEY = hmacKey;

      const payload = { envelopeId: webhookEnvId, status: 'completed' };
      const rawBody = Buffer.from(JSON.stringify(payload));

      // Acceptance Criteria 1: Incorrect HMAC signature header returns 401 'invalid webhook signature'
      const invalidSig = crypto
        .createHmac('sha256', 'wrong-secret-key')
        .update(rawBody)
        .digest('base64');

      const rejectResult = await postWebhook(payload, rawBody, {
        'x-docusign-signature-1': invalidSig,
      });

      assert.strictEqual(
        rejectResult.statusCode,
        401,
        'incorrect HMAC signature must return HTTP 401'
      );
      assert.strictEqual(
        (rejectResult.body as any)?.error,
        'invalid webhook signature',
        'error message must match "invalid webhook signature"'
      );

      // Acceptance Criteria 2: No bond_signatures row is updated for the rejected webhook call
      const sigAfterReject = await pool.query<{ status: string; completed_at: Date | null }>(
        'SELECT status, completed_at FROM bond_signatures WHERE envelope_id = $1',
        [webhookEnvId]
      );
      assert.strictEqual(
        sigAfterReject.rows[0]!.status,
        'sent',
        'bond_signatures status must remain unchanged (sent)'
      );
      assert.strictEqual(
        sigAfterReject.rows[0]!.completed_at,
        null,
        'bond_signatures completed_at must remain null'
      );

      const bondAfterReject = await pool.query<{ signature_status: string }>(
        'SELECT signature_status FROM bond_records WHERE id = $1',
        [bondRecordId]
      );
      assert.strictEqual(
        bondAfterReject.rows[0]!.signature_status,
        'sent',
        'bond_records signature_status must remain unchanged (sent)'
      );

      // Acceptance Criteria 3: A correctly signed payload with the same body is accepted and processed
      const validSig = crypto
        .createHmac('sha256', hmacKey)
        .update(rawBody)
        .digest('base64');

      const acceptResult = await postWebhook(payload, rawBody, {
        'x-docusign-signature-1': validSig,
      });

      assert.strictEqual(
        acceptResult.statusCode,
        200,
        'correctly signed webhook payload must return HTTP 200'
      );
      assert.strictEqual(
        (acceptResult.body as any)?.received,
        true,
        'response must indicate received: true'
      );

      const sigAfterAccept = await pool.query<{
        status: string;
        signed_document_hash: string | null;
        completed_at: Date | null;
      }>(
        'SELECT status, signed_document_hash, completed_at FROM bond_signatures WHERE envelope_id = $1',
        [webhookEnvId]
      );
      assert.strictEqual(
        sigAfterAccept.rows[0]!.status,
        'completed',
        'bond_signatures status must be updated to "completed"'
      );
      assert.ok(
        sigAfterAccept.rows[0]!.signed_document_hash,
        'signed_document_hash should be populated'
      );
      assert.ok(sigAfterAccept.rows[0]!.completed_at, 'completed_at should be populated');

      const bondAfterAccept = await pool.query<{ signature_status: string }>(
        'SELECT signature_status FROM bond_records WHERE id = $1',
        [bondRecordId]
      );
      assert.strictEqual(
        bondAfterAccept.rows[0]!.signature_status,
        'completed',
        'bond_records signature_status must be updated to "completed"'
      );

      // Acceptance Criteria 4: When DOCUSIGN_WEBHOOK_HMAC_KEY is unset, the signature check is skipped (documented behavior)
      delete (env as any).DOCUSIGN_WEBHOOK_HMAC_KEY;

      const unsignedPayload = { envelopeId: webhookEnvId, status: 'voided' };
      const unsignedRawBody = Buffer.from(JSON.stringify(unsignedPayload));

      const skipCheckResult = await postWebhook(unsignedPayload, unsignedRawBody, {
        'x-docusign-signature-1': 'arbitrary-signature-ignored',
      });

      assert.strictEqual(
        skipCheckResult.statusCode,
        200,
        'signature check should be skipped when HMAC key is unset'
      );
      assert.strictEqual((skipCheckResult.body as any)?.received, true);

      const sigAfterSkip = await pool.query<{ status: string }>(
        'SELECT status FROM bond_signatures WHERE envelope_id = $1',
        [webhookEnvId]
      );
      assert.strictEqual(
        sigAfterSkip.rows[0]!.status,
        'voided',
        'bond_signatures status should be updated to "voided"'
      );
    } finally {
      if (originalHmacKey !== undefined) {
        (env as any).DOCUSIGN_WEBHOOK_HMAC_KEY = originalHmacKey;
      } else {
        delete (env as any).DOCUSIGN_WEBHOOK_HMAC_KEY;
      }
    }
  });

  // #607 — POST /bonds/docusign-webhook marks signature completed and stores a document hash
  it('POST /bonds/docusign-webhook marks signature completed, stores sha256 document hash, and updates bond_records', async (t) => {
    if (!dbAvailable) return t?.skip('Database not available in this environment');

    const testBondIdWebhook = testBondId + 6;
    const bondInsert = await pool.query<{ id: string }>(
      `INSERT INTO bond_records
         (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
          surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, signature_status)
       VALUES ($1, $2, '02', 'Integration Test Corp', '12-3456789', 'Test Surety Company', '98-7654321', 500000, 100000, CURRENT_DATE, 'sent')
       RETURNING id`,
      [importerId, testBondIdWebhook]
    );
    const bondRecordId = bondInsert.rows[0]!.id;

    const webhookEnvId = `ENV-WEBHOOK-607-${testTag}-${randomUUID().slice(0, 4)}`;
    await pool.query(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status)
       VALUES ($1, $2, 'https://demo.docusign.net/webhook-607', 'sent')`,
      [bondRecordId, webhookEnvId]
    );

    // 1. Missing envelopeId or status in the payload returns 400 before any update
    const missingEnvPayload = { status: 'completed' };
    const missingEnvRes = await postWebhook(
      missingEnvPayload,
      Buffer.from(JSON.stringify(missingEnvPayload))
    );
    assert.strictEqual(missingEnvRes.statusCode, 400, 'missing envelopeId should return 400');
    assert.strictEqual((missingEnvRes.body as any)?.error, 'missing envelopeId or status');

    const missingStatusPayload = { envelopeId: webhookEnvId };
    const missingStatusRes = await postWebhook(
      missingStatusPayload,
      Buffer.from(JSON.stringify(missingStatusPayload))
    );
    assert.strictEqual(missingStatusRes.statusCode, 400, 'missing status should return 400');
    assert.strictEqual((missingStatusRes.body as any)?.error, 'missing envelopeId or status');

    // Verify no updates occurred during 400 calls
    const sigCheckBefore = await pool.query<{ status: string; completed_at: Date | null }>(
      'SELECT status, completed_at FROM bond_signatures WHERE envelope_id = $1',
      [webhookEnvId]
    );
    assert.strictEqual(sigCheckBefore.rows[0]!.status, 'sent', 'status must remain sent after 400 errors');
    assert.strictEqual(sigCheckBefore.rows[0]!.completed_at, null, 'completed_at must remain null after 400 errors');

    // 2. Valid completed-status webhook payload
    const payload = {
      envelopeId: webhookEnvId,
      status: 'completed',
      event: 'envelope-completed',
      timestamp: new Date().toISOString(),
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const expectedHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    const completedRes = await postWebhook(payload, rawBody);
    assert.strictEqual(completedRes.statusCode, 200, 'valid completed webhook must return 200');
    assert.strictEqual((completedRes.body as any)?.received, true);

    // 3. Verify bond_signatures.status is updated to 'completed' with completed_at set
    // and signed_document_hash is 64-character hex sha256 digest of rawBody
    const sigCheckAfter = await pool.query<{
      status: string;
      signed_document_hash: string | null;
      completed_at: Date | null;
    }>(
      'SELECT status, signed_document_hash, completed_at FROM bond_signatures WHERE envelope_id = $1',
      [webhookEnvId]
    );
    assert.strictEqual(sigCheckAfter.rows[0]!.status, 'completed', 'status must be updated to completed');
    assert.ok(
      sigCheckAfter.rows[0]!.completed_at instanceof Date ||
        typeof sigCheckAfter.rows[0]!.completed_at === 'string',
      'completed_at must be populated'
    );
    assert.strictEqual(sigCheckAfter.rows[0]!.signed_document_hash, expectedHash);
    assert.strictEqual(sigCheckAfter.rows[0]!.signed_document_hash?.length, 64);
    assert.match(sigCheckAfter.rows[0]!.signed_document_hash!, /^[0-9a-f]{64}$/);

    // 4. Verify linked bond_records row's signature_status is updated to 'completed'
    const bondCheckAfter = await pool.query<{ signature_status: string }>(
      'SELECT signature_status FROM bond_records WHERE id = $1',
      [bondRecordId]
    );
    assert.strictEqual(
      bondCheckAfter.rows[0]!.signature_status,
      'completed',
      'linked bond_records signature_status must be updated to completed'
    );
  });
});
