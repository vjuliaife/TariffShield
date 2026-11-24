/**
 * Integration coverage for POST /auth/saml/:provider/callback (#577, #578).
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
process.env.SAML_OKTA_ENTRY_POINT = 'https://idp.example.test/sso';
process.env.SAML_OKTA_CERT = 'test-cert';

const { pool } = await import('../../db.js');
const { env } = await import('../../config/env.js');
const { authRouter } = await import('../../routes/auth.js');

(env as any).SAML_OKTA_ENTRY_POINT = 'https://idp.example.test/sso';
(env as any).SAML_OKTA_CERT = 'test-cert';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/auth', authRouter);
const server = createServer(app);

const testTag = randomUUID().slice(0, 8);
const email = `saml-${testTag}@example.com`;
const nameId = `nameid-${testTag}`;
const createdUserIds: string[] = [];
let serverUrl: string;

function samlXmlWithNameIdAndEmail(subjectNameId: string, subjectEmail: string): string {
  return [
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">',
    '<saml:Assertion>',
    `<saml:Subject><saml:NameID>${subjectNameId}</saml:NameID></saml:Subject>`,
    '<saml:AttributeStatement>',
    `<saml:Attribute Name="email"><saml:AttributeValue>${subjectEmail}</saml:AttributeValue></saml:Attribute>`,
    '</saml:AttributeStatement>',
    '</saml:Assertion>',
    '</samlp:Response>',
  ].join('');
}

async function postCallback(body: Record<string, unknown>) {
  return fetch(`${serverUrl}/auth/saml/okta/callback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
}

async function usersBySamlSubject() {
  return pool.query<{
    id: string;
    email: string;
    role: string;
    saml_subject_id: string;
    idp_entity_id: string;
  }>(
    `SELECT id, email, role, saml_subject_id, idp_entity_id
     FROM users
     WHERE saml_subject_id = $1 AND idp_entity_id = $2`,
    [nameId, 'https://idp.example.test/sso']
  );
}

describe('POST /auth/saml/:provider/callback integration (#577, #578)', () => {
  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    const users = await usersBySamlSubject();
    for (const row of users.rows) {
      if (!createdUserIds.includes(row.id)) createdUserIds.push(row.id);
    }
    if (createdUserIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await pool.end();
  });

  it('rejects malformed or NameID-less SAMLResponse without creating a user (#577)', async () => {
    const beforeCount = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    const beforeTotal = Number(beforeCount.rows[0]!.count);

    const missingResponse = await postCallback({});
    assert.equal(missingResponse.status, 400);
    assert.deepEqual(await missingResponse.json(), { error: 'missing SAMLResponse' });

    const nonBase64 = await postCallback({ SAMLResponse: 'not-base64!@#' });
    assert.equal(nonBase64.status, 400);
    assert.deepEqual(await nonBase64.json(), { error: 'malformed SAMLResponse' });

    const missingNameIdXml = '<samlp:Response><saml:Assertion><saml:AttributeStatement></saml:AttributeStatement></saml:Assertion></samlp:Response>';
    const missingNameId = await postCallback({
      SAMLResponse: Buffer.from(missingNameIdXml, 'utf8').toString('base64'),
    });
    assert.equal(missingNameId.status, 401);
    assert.deepEqual(await missingNameId.json(), { error: 'SAML assertion missing NameID' });

    const afterCount = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    const afterTotal = Number(afterCount.rows[0]!.count);
    assert.equal(afterTotal, beforeTotal, 'rejected SAML callbacks must not create users');

    const bySubject = await usersBySamlSubject();
    assert.equal(bySubject.rowCount, 0);
  });

  it('upserts a surety_admin user on first login and reuses the user on repeat (#578)', async () => {
    const samlResponse = Buffer.from(samlXmlWithNameIdAndEmail(nameId, email), 'utf8').toString(
      'base64'
    );

    const first = await postCallback({ SAMLResponse: samlResponse });
    const firstBody = (await first.json()) as {
      token?: string;
      user?: { id?: string; email?: string; role?: string };
    };
    assert.equal(first.status, 200);
    assert.equal(firstBody.user?.role, 'surety_admin');
    assert.equal(firstBody.user?.email, email);
    assert.ok(firstBody.token);
    assert.ok(firstBody.user?.id);
    createdUserIds.push(firstBody.user!.id!);

    const usersAfterFirst = await usersBySamlSubject();
    assert.equal(usersAfterFirst.rowCount, 1);
    const created = usersAfterFirst.rows[0]!;
    assert.equal(created.role, 'surety_admin');
    assert.equal(created.saml_subject_id, nameId);
    assert.equal(created.idp_entity_id, 'https://idp.example.test/sso');

    const meRes = await fetch(`${serverUrl}/auth/me`, {
      headers: {
        authorization: `Bearer ${firstBody.token}`,
        connection: 'close',
      },
    });
    const meBody = (await meRes.json()) as { user?: { id?: string; email?: string } };
    assert.equal(meRes.status, 200);
    assert.equal(meBody.user?.id, created.id);
    assert.equal(meBody.user?.email, email);

    const second = await postCallback({ SAMLResponse: samlResponse });
    const secondBody = (await second.json()) as { user?: { id?: string } };
    assert.equal(second.status, 200);
    assert.equal(secondBody.user?.id, created.id);

    const usersAfterSecond = await usersBySamlSubject();
    assert.equal(usersAfterSecond.rowCount, 1);
  });
});
