/**
 * Integration coverage for POST /auth/logout session revocation (#575).
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
const { authRouter } = await import('../../routes/auth.js');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
const server = createServer(app);

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
let serverUrl: string;

async function createUser(email: string) {
  const result = await pool.query<{ id: string; email: string; role: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'importer')
     RETURNING id, email, role`,
    [email, 'test-hash-not-real']
  );
  const user = result.rows[0]!;
  userIds.push(user.id);
  return user;
}

async function issueToken(user: { id: string; email: string; role: string }) {
  const sessionId = await createSession(user.id);
  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role as 'importer',
    sessionId,
  });
  return { token, sessionId };
}

describe('POST /auth/logout integration (#575)', () => {
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
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  it('revokes the current session token and preserves other active sessions', async () => {
    const user = await createUser(`logout-${testTag}@example.com`);
    const sessionA = await issueToken(user);
    const sessionB = await issueToken(user);

    const logoutRes = await fetch(`${serverUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({}),
    });
    const logoutBody = (await logoutRes.json()) as { message?: string };

    assert.equal(logoutRes.status, 200);
    assert.equal(logoutBody.message, 'logged out');

    const revokedSession = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM user_sessions WHERE id = $1',
      [sessionA.sessionId]
    );
    assert.equal(revokedSession.rowCount, 1);
    assert.ok(revokedSession.rows[0]!.revoked_at, 'revoked session should be persisted in Postgres');

    const meRevoked = await fetch(`${serverUrl}/auth/me`, {
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        connection: 'close',
      },
    });
    const meRevokedBody = (await meRevoked.json()) as { error?: string };

    assert.equal(meRevoked.status, 401);
    assert.equal(meRevokedBody.error, 'session expired or not found');

    const meActive = await fetch(`${serverUrl}/auth/me`, {
      headers: {
        authorization: `Bearer ${sessionB.token}`,
        connection: 'close',
      },
    });
    const meActiveBody = (await meActive.json()) as { user?: { id?: string } };

    assert.equal(meActive.status, 200);
    assert.equal(meActiveBody.user?.id, user.id);

    const activeSession = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM user_sessions WHERE id = $1',
      [sessionB.sessionId]
    );
    assert.equal(activeSession.rows[0]!.revoked_at, null);
  });
});
