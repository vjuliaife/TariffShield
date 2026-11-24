/**
 * Integration coverage for POST /importers role gating (#579).
 *
 * Run via: npm run test:integration --workspace=apps/api
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 */

import { after, before, describe, it, mock } from 'node:test';
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
const stellar = await import('../../stellar.js');
const { importersRouter } = await import('../../routes/importers.js');

const app = express();
app.use(express.json());
app.use('/importers', importersRouter);
const server = createServer(app);

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
let serverUrl: string;

async function createUser(role: 'importer' | 'surety_admin') {
  const email = `${role}-${testTag}-${randomUUID().slice(0, 6)}@example.com`;
  const result = await pool.query<{ id: string; email: string; role: 'importer' | 'surety_admin' }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, email, role`,
    [email, 'test-hash-not-real', role]
  );
  const user = result.rows[0]!;
  userIds.push(user.id);
  return user;
}

async function tokenFor(user: { id: string; email: string; role: 'importer' | 'surety_admin' }) {
  const sessionId = await createSession(user.id);
  return signToken({
    id: user.id,
    email: user.email,
    role: user.role,
    sessionId,
  });
}

describe('POST /importers integration (#579)', () => {
  before(async () => {
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
      await pool.query('DELETE FROM importers WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  it('rejects non-importer roles with 403 and allows an importer role (#579)', async () => {
    const surety = await createUser('surety_admin');
    const importer = await createUser('importer');
    const suretyToken = await tokenFor(surety);
    const importerToken = await tokenFor(importer);
    const payload = {
      legalName: `Importer Corp ${testTag}`,
      bondId: 123456,
      initialRequiredCollateral: '1000000',
    };

    const suretyRes = await fetch(`${serverUrl}/importers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${suretyToken}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify(payload),
    });
    const suretyBody = (await suretyRes.json()) as Record<string, unknown>;

    assert.equal(suretyRes.status, 403);
    assert.deepEqual(suretyBody, { error: 'only importer accounts can register' });
    assert.equal('stellarSecret' in suretyBody, false);
    assert.equal('onChain' in suretyBody, false);
    assert.equal('stellarTxUrl' in suretyBody, false);

    const importerRowsAfterReject = await pool.query<{ id: string }>(
      'SELECT id FROM importers WHERE user_id = $1',
      [surety.id]
    );
    assert.equal(importerRowsAfterReject.rowCount, 0, 'rejected surety call must not insert importer row');

    mock.method(stellar.contractClient, 'registerImporter', async () => ({
      txHash: 'mock-register-tx-hash',
      ledgerSequence: 1,
      applicationOrder: 1,
    }));
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://friendbot.stellar.org/')) {
        return new Response('{}', { status: 200 });
      }
      return originalFetch(input, init);
    });

    try {
      const importerRes = await fetch(`${serverUrl}/importers`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${importerToken}`,
          'content-type': 'application/json',
          connection: 'close',
        },
        body: JSON.stringify(payload),
      });
      const importerBody = (await importerRes.json()) as Record<string, unknown>;

      assert.equal(importerRes.status, 200);
      const importer = (importerBody.importer ?? {}) as Record<string, unknown>;
      assert.equal(importer.legalName, payload.legalName);
      assert.equal(typeof importer.stellarSecret, 'string');
      assert.equal(typeof importer.registeredOnChainTx, 'string');
    } finally {
      mock.restoreAll();
    }
  });
});
