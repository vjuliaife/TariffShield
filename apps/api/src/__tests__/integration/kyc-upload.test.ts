/**
 * Integration coverage for POST /importers/:id/kyc authorization boundaries.
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

stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { pool, createSession } = await import('../../db.js');
const { signToken } = await import('../../auth.js');
const { kycRouter } = await import('../../routes/kyc.js');

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const importerIds: string[] = [];
const app = express();
app.use(express.json());
app.use('/importers', kycRouter);
const server = createServer(app);

let serverUrl: string;
let suretyToken: string;
let importerToken: string;
let importerId: string;
let otherImporterId: string;

const kycUpload = {
  documentType: 'ein_confirmation',
  fileBase64: Buffer.from('%PDF-test document').toString('base64'),
  mimeType: 'application/pdf',
  fileName: 'integration-test.pdf',
};

async function postKyc(targetImporterId: string, token: string) {
  return fetch(`${serverUrl}/importers/${targetImporterId}/kyc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify(kycUpload),
  });
}

async function kycDocumentCount(targetImporterId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM kyc_documents WHERE importer_id = $1',
    [targetImporterId]
  );
  return Number(result.rows[0]!.count);
}

describe('POST /importers/:id/kyc integration (#624)', () => {
  before(async () => {
    const surety = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'surety_admin')
       RETURNING id, email`,
      [`surety-${testTag}@example.com`, 'test-hash-not-real']
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

    const owner = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id, email`,
      [`owner-${testTag}@example.com`, 'test-hash-not-real']
    );
    const ownerUser = owner.rows[0]!;
    userIds.push(ownerUser.id);
    const ownerSession = await createSession(ownerUser.id);
    importerToken = signToken({
      id: ownerUser.id,
      email: ownerUser.email,
      role: 'importer',
      sessionId: ownerSession,
    });

    const otherOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id`,
      [`other-${testTag}@example.com`, 'test-hash-not-real']
    );
    userIds.push(otherOwner.rows[0]!.id);

    for (const [userId, suffix] of [
      [ownerUser.id, 'Owner'],
      [otherOwner.rows[0]!.id, 'Other'],
    ]) {
      const importer = await pool.query<{ id: string }>(
        `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          userId,
          `KYC Integration ${suffix} ${testTag}`,
          Math.floor(Math.random() * 9_000_000) + 1_000_000,
          `G${randomUUID().replace(/-/g, '').slice(0, 55)}`,
        ]
      );
      importerIds.push(importer.rows[0]!.id);
    }

    importerId = importerIds[0]!;
    otherImporterId = importerIds[1]!;

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
    if (importerIds.length) {
      await pool.query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [importerIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  it('rejects surety_admin uploads with 403 and inserts no KYC document', async () => {
    const response = await postKyc(importerId, suretyToken);
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: 'only importers can upload KYC documents' });
    assert.equal(await kycDocumentCount(importerId), 0);
  });

  it('allows an importer to upload a document to their own importer id', async () => {
    const response = await postKyc(importerId, importerToken);
    const body = (await response.json()) as { document?: { document_type?: string } };

    assert.equal(response.status, 201);
    assert.equal(body.document?.document_type, 'ein_confirmation');
    assert.equal(await kycDocumentCount(importerId), 1);
  });

  it('returns 404 when an importer uploads to another importer id', async () => {
    const response = await postKyc(otherImporterId, importerToken);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, { error: 'not found' });
    assert.equal(await kycDocumentCount(otherImporterId), 0);
  });
});
