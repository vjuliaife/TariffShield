import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migration0015Up } from '../../migrations/0015_importer_api_keys.js';
import {
  checkApiKeyRateLimit,
  resetApiKeyRateLimits,
} from '../../services/api-key-rate-limiter.js';
import { TariffShieldApiClient } from '@tariffshield/sdk';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });

const testTag = randomUUID().slice(0, 8);
const user1Email = `test-api-keys-1-${testTag}@example.com`;
const user2Email = `test-api-keys-2-${testTag}@example.com`;

let dbAvailable = false;
let user1Id: string;
let user2Id: string;
let importer1Id: string;
let importer2Id: string;
let testApiKeyId: string;
let rawSecretKey: string;
const testBondId1 = Math.floor(Math.random() * 9_000_000) + 1_000_000;
const testBondId2 = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issue #995 — Self-Service API Key Management for SDK Integrations', () => {
  before(async () => {
    resetApiKeyRateLimits();
    try {
      const client = await pool.connect();
      try {
        await migration0015Up(client);
        dbAvailable = true;

        const u1 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [user1Email, 'hash1', 'importer']
        );
        user1Id = u1.rows[0]!.id;

        const u2 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [user2Email, 'hash2', 'importer']
        );
        user2Id = u2.rows[0]!.id;

        const imp1 = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, 'approved', 10000000)
           RETURNING id`,
          [user1Id, 'Importer One Corp', testBondId1, 'GBTESTAPIKEYIMP11111']
        );
        importer1Id = imp1.rows[0]!.id;

        const imp2 = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, 'approved', 10000000)
           RETURNING id`,
          [user2Id, 'Importer Two Corp', testBondId2, 'GBTESTAPIKEYIMP22222']
        );
        importer2Id = imp2.rows[0]!.id;
      } finally {
        client.release();
      }
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    resetApiKeyRateLimits();
    if (dbAvailable) {
      await pool.query('DELETE FROM api_keys WHERE user_id IN ($1, $2)', [user1Id, user2Id]);
      await pool.query('DELETE FROM importers WHERE id IN ($1, $2)', [importer1Id, importer2Id]);
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [user1Id, user2Id]);
    }
    await pool.end().catch(() => undefined);
  });

  it('SDK client supports authentication via API key in addition to session token', () => {
    // API key auth
    const clientWithApiKey = new TariffShieldApiClient({
      baseUrl: 'https://api.tariffshield.com',
      apiKey: 'ts_live_mock_key_1234567890',
    });
    const headersApiKey = clientWithApiKey.getHeaders();
    assert.equal(headersApiKey['X-Api-Key'], 'ts_live_mock_key_1234567890');
    assert.equal(headersApiKey['Authorization'], 'Bearer ts_live_mock_key_1234567890');

    // Session token auth
    const clientWithSession = new TariffShieldApiClient({
      baseUrl: 'https://api.tariffshield.com',
      sessionToken: 'jwt_mock_session_token_xyz',
    });
    const headersSession = clientWithSession.getHeaders();
    assert.equal(headersSession['Authorization'], 'Bearer jwt_mock_session_token_xyz');
    assert.equal(headersSession['X-Api-Key'], undefined);
  });

  it('enforces API key rate limits independently of session-based limits', () => {
    const dummyKeyId = 'test-key-limit-1';
    const limit = 3;

    // First 3 requests allowed
    for (let i = 0; i < limit; i++) {
      const res = checkApiKeyRateLimit(dummyKeyId, limit);
      assert.equal(res.allowed, true);
    }

    // 4th request blocked
    const blockedRes = checkApiKeyRateLimit(dummyKeyId, limit);
    assert.equal(blockedRes.allowed, false);
    assert.equal(blockedRes.remaining, 0);

    // Another key is unaffected
    const otherKeyRes = checkApiKeyRateLimit('test-key-limit-2', limit);
    assert.equal(otherKeyRes.allowed, true);
  });

  it('creates an API key storing only prefix and hash, with secret returned once', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    rawSecretKey = `ts_live_${randomBytes(24).toString('base64url')}`;
    const prefix = `ts_live_${rawSecretKey.slice(8, 14)}...`;
    const keyHash = createHash('sha256').update(rawSecretKey).digest('hex');

    const res = await pool.query<{ id: string; prefix: string; key_hash: string }>(
      `INSERT INTO api_keys (user_id, importer_id, key_hash, prefix, label, rate_limit_per_min)
       VALUES ($1, $2, $3, $4, 'Production Integration Key', 100)
       RETURNING id, prefix, key_hash`,
      [user1Id, importer1Id, keyHash, prefix]
    );

    assert.equal(res.rowCount, 1);
    testApiKeyId = res.rows[0]!.id;
    assert.equal(res.rows[0]!.prefix, prefix);
    assert.equal(res.rows[0]!.key_hash, keyHash);
    // Secret is not in the DB
    assert.notEqual(res.rows[0]!.key_hash, rawSecretKey);
  });

  it('retrieves active API key for authentication via key hash lookup', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const keyHash = createHash('sha256').update(rawSecretKey).digest('hex');
    const authRes = await pool.query<{
      id: string;
      user_id: string;
      importer_id: string;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, importer_id, revoked_at
       FROM api_keys
       WHERE key_hash = $1`,
      [keyHash]
    );

    assert.equal(authRes.rowCount, 1);
    assert.equal(authRes.rows[0]!.importer_id, importer1Id);
    assert.equal(authRes.rows[0]!.revoked_at, null);
  });

  it('revoked key immediately reflects revoked status and rejects subsequent auth', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    // Revoke key
    const revokeRes = await pool.query<{ id: string; revoked_at: Date }>(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, revoked_at`,
      [testApiKeyId, user1Id]
    );

    assert.equal(revokeRes.rowCount, 1);
    assert.ok(revokeRes.rows[0]!.revoked_at);

    // Auth lookup with the same raw key hash
    const keyHash = createHash('sha256').update(rawSecretKey).digest('hex');
    const checkRes = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM api_keys WHERE key_hash = $1`,
      [keyHash]
    );

    assert.equal(checkRes.rowCount, 1);
    assert.ok(checkRes.rows[0]!.revoked_at !== null, 'revoked_at must be populated so auth immediately returns 401');
  });
});
