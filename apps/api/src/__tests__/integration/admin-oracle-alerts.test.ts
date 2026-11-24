/**
 * Integration coverage for GET and PATCH /admin/oracle-alerts authorization,
 * pagination, and acknowledgment (#596, #597).
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
const { adminRouter } = await import('../../routes/admin.js');

interface OracleAlertRow {
  id: string;
  importer_id: string;
  old_value: string;
  new_value: string;
  pct_change: string;
  tx_hash: string;
  alerted_at: string;
  acknowledged_at: string | null;
}

interface OracleAlertsResponse {
  alerts: OracleAlertRow[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

interface AcknowledgeAlertResponse {
  alert?: OracleAlertRow;
  error?: string;
}

const testTag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const importerIds: string[] = [];
const alertIds: string[] = [];

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const server = createServer(app);

let serverUrl: string;
let suretyToken: string;
let importerToken: string;
let importerId: string;

const insertedAlerts: Array<{ id: string; alerted_at: string }> = [];

async function getAlerts(
  token?: string,
  query?: Record<string, string | number>
): Promise<Response> {
  const url = new URL(`${serverUrl}/admin/oracle-alerts`);
  if (query) {
    for (const [key, val] of Object.entries(query)) {
      url.searchParams.set(key, String(val));
    }
  }
  const headers: Record<string, string> = { connection: 'close' };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(url.toString(), {
    method: 'GET',
    headers,
  });
}

async function acknowledgeAlert(
  alertId: string,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { connection: 'close' };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return fetch(`${serverUrl}/admin/oracle-alerts/${alertId}/acknowledge`, {
    method: 'PATCH',
    headers,
  });
}

describe('admin oracle-alerts routes integration (#596, #597)', () => {
  before(async () => {
    // 1. Create surety_admin user and session
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

    // 2. Create importer user and session
    const importer = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'importer')
       RETURNING id, email`,
      [`importer-${testTag}@example.com`, 'test-hash-not-real']
    );
    const importerUser = importer.rows[0]!;
    userIds.push(importerUser.id);
    const importerSession = await createSession(importerUser.id);
    importerToken = signToken({
      id: importerUser.id,
      email: importerUser.email,
      role: 'importer',
      sessionId: importerSession,
    });

    // 3. Create importer record
    const importerRecord = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        importerUser.id,
        `Oracle Alert Test Corp ${testTag}`,
        Math.floor(Math.random() * 9_000_000) + 1_000_000,
        `G${randomUUID().replace(/-/g, '').slice(0, 55)}`,
      ]
    );
    importerId = importerRecord.rows[0]!.id;
    importerIds.push(importerId);

    // 4. Seed test oracle alerts with distinct alerted_at timestamps
    const baseTime = Date.now();
    const seedData = [
      {
        old_value: '100000',
        new_value: '200000',
        pct_change: '100.00',
        tx_hash: `0x${randomUUID().replace(/-/g, '')}`,
        alerted_at: new Date(baseTime - 3600000).toISOString(), // oldest (1 hr ago)
      },
      {
        old_value: '200000',
        new_value: '350000',
        pct_change: '75.00',
        tx_hash: `0x${randomUUID().replace(/-/g, '')}`,
        alerted_at: new Date(baseTime - 1800000).toISOString(), // middle (30 min ago)
      },
      {
        old_value: '350000',
        new_value: '500000',
        pct_change: '42.86',
        tx_hash: `0x${randomUUID().replace(/-/g, '')}`,
        alerted_at: new Date(baseTime - 60000).toISOString(), // newest (1 min ago)
      },
    ];

    for (const record of seedData) {
      const res = await pool.query<{ id: string; alerted_at: string }>(
        `INSERT INTO oracle_alerts (importer_id, old_value, new_value, pct_change, tx_hash, alerted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, alerted_at`,
        [
          importerId,
          record.old_value,
          record.new_value,
          record.pct_change,
          record.tx_hash,
          record.alerted_at,
        ]
      );
      const row = res.rows[0]!;
      alertIds.push(row.id);
      insertedAlerts.push(row);
    }

    // 5. Start test Express server
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
    if (alertIds.length) {
      await pool.query('DELETE FROM oracle_alerts WHERE id = ANY($1::uuid[])', [alertIds]);
    }
    if (importerIds.length) {
      await pool.query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [importerIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
  });

  describe('GET /admin/oracle-alerts (#596)', () => {
    it('importer token returns 403 "surety admin only"', async () => {
      const response = await getAlerts(importerToken);
      assert.strictEqual(response.status, 403, 'importer request should return 403');
      const body = (await response.json()) as OracleAlertsResponse;
      assert.strictEqual(body.error, 'surety admin only');
    });

    it('surety_admin token returns alerts ordered alerted_at DESC with a total count', async () => {
      const response = await getAlerts(suretyToken);
      assert.strictEqual(response.status, 200, 'surety_admin request should return 200');
      const body = (await response.json()) as OracleAlertsResponse;

      assert.strictEqual(typeof body.total, 'number', 'total must be a number');
      assert.ok(body.total >= 3, 'total must reflect at least the inserted alerts');
      assert.ok(Array.isArray(body.alerts), 'alerts must be an array');
      assert.ok(body.alerts.length >= 3, 'alerts array must contain at least the inserted alerts');

      // Verify ordering by alerted_at DESC
      for (let i = 0; i < body.alerts.length - 1; i++) {
        const current = new Date(body.alerts[i]!.alerted_at).getTime();
        const next = new Date(body.alerts[i + 1]!.alerted_at).getTime();
        assert.ok(
          current >= next,
          `alerts must be sorted alerted_at DESC: ${body.alerts[i]!.alerted_at} should be >= ${body.alerts[i + 1]!.alerted_at}`
        );
      }

      // Verify the inserted alerts appear in the expected descending order (newest first)
      const returnedIds = body.alerts.map((a) => a.id);
      const newestInsertedId = alertIds[2]!; // 1 min ago
      const middleInsertedId = alertIds[1]!; // 30 min ago
      const oldestInsertedId = alertIds[0]!; // 1 hr ago

      const idxNewest = returnedIds.indexOf(newestInsertedId);
      const idxMiddle = returnedIds.indexOf(middleInsertedId);
      const idxOldest = returnedIds.indexOf(oldestInsertedId);

      assert.ok(idxNewest !== -1, 'newest inserted alert must be in response');
      assert.ok(idxMiddle !== -1, 'middle inserted alert must be in response');
      assert.ok(idxOldest !== -1, 'oldest inserted alert must be in response');
      assert.ok(
        idxNewest < idxMiddle && idxMiddle < idxOldest,
        'inserted alerts must appear in newest -> oldest order'
      );
    });

    it('limit above 100 is clamped to 100 in the response', async () => {
      const response = await getAlerts(suretyToken, { limit: 150 });
      assert.strictEqual(response.status, 200, 'request should succeed');
      const body = (await response.json()) as OracleAlertsResponse;
      assert.strictEqual(body.limit, 100, 'limit above 100 should be clamped to 100');
      assert.ok(body.alerts.length <= 100, 'returned alerts should not exceed 100');
    });

    it('offset beyond the total row count returns an empty alerts array with the correct total', async () => {
      // Fetch initial total to know current row count
      const baseline = await getAlerts(suretyToken);
      const baselineBody = (await baseline.json()) as OracleAlertsResponse;
      const currentTotal = baselineBody.total;

      const beyondOffset = currentTotal + 500;
      const response = await getAlerts(suretyToken, { offset: beyondOffset });
      assert.strictEqual(response.status, 200, 'request should succeed');
      const body = (await response.json()) as OracleAlertsResponse;

      assert.ok(Array.isArray(body.alerts), 'alerts should be an array');
      assert.strictEqual(body.alerts.length, 0, 'alerts array must be empty');
      assert.strictEqual(body.total, currentTotal, 'total count must be accurate');
      assert.strictEqual(body.offset, beyondOffset, 'offset should match requested offset');
    });

    it('respects limit and offset pagination parameters', async () => {
      const page1Res = await getAlerts(suretyToken, { limit: 1, offset: 0 });
      assert.strictEqual(page1Res.status, 200);
      const page1 = (await page1Res.json()) as OracleAlertsResponse;
      assert.strictEqual(page1.limit, 1);
      assert.strictEqual(page1.offset, 0);
      assert.strictEqual(page1.alerts.length, 1);

      const page2Res = await getAlerts(suretyToken, { limit: 1, offset: 1 });
      assert.strictEqual(page2Res.status, 200);
      const page2 = (await page2Res.json()) as OracleAlertsResponse;
      assert.strictEqual(page2.limit, 1);
      assert.strictEqual(page2.offset, 1);
      assert.strictEqual(page2.alerts.length, 1);

      // The two alerts should be different
      assert.notStrictEqual(
        page1.alerts[0]!.id,
        page2.alerts[0]!.id,
        'different pages should return different alerts'
      );

      // First page alert should be newer than or equal to second page alert
      const time1 = new Date(page1.alerts[0]!.alerted_at).getTime();
      const time2 = new Date(page2.alerts[0]!.alerted_at).getTime();
      assert.ok(time1 >= time2, 'page 1 alert must be newer than or equal to page 2 alert');
    });

    it('defaults limit to 50 and offset to 0 when omitted', async () => {
      const response = await getAlerts(suretyToken);
      assert.strictEqual(response.status, 200);
      const body = (await response.json()) as OracleAlertsResponse;
      assert.strictEqual(body.limit, 50, 'default limit should be 50');
      assert.strictEqual(body.offset, 0, 'default offset should be 0');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await getAlerts();
      assert.strictEqual(response.status, 401, 'unauthenticated request should return 401');
      const body = (await response.json()) as OracleAlertsResponse;
      assert.strictEqual(body.error, 'missing bearer token');
    });
  });

  describe('PATCH /admin/oracle-alerts/:id/acknowledge (#597)', () => {
    it('returns 404 "alert not found" for an unknown alert id', async () => {
      const unknownId = randomUUID();
      const response = await acknowledgeAlert(unknownId, suretyToken);
      assert.strictEqual(response.status, 404, 'unknown alert id should return 404');
      const body = (await response.json()) as AcknowledgeAlertResponse;
      assert.strictEqual(body.error, 'alert not found');
    });

    it('returns 200 with acknowledged_at populated in the response for an existing alert', async () => {
      const targetAlertId = alertIds[0]!;
      const response = await acknowledgeAlert(targetAlertId, suretyToken);
      assert.strictEqual(response.status, 200, 'acknowledging existing alert should return 200');
      const body = (await response.json()) as AcknowledgeAlertResponse;
      assert.ok(body.alert, 'response should include the alert object');
      assert.strictEqual(body.alert.id, targetAlertId, 'returned alert id should match');
      assert.ok(body.alert.acknowledged_at, 'acknowledged_at must be populated');
      const ackDate = new Date(body.alert.acknowledged_at);
      assert.ok(!isNaN(ackDate.getTime()), 'acknowledged_at must be a valid date');

      // Verify directly in the database
      const dbCheck = await pool.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM oracle_alerts WHERE id = $1',
        [targetAlertId]
      );
      assert.ok(dbCheck.rows[0]?.acknowledged_at, 'database row must have acknowledged_at set');
    });

    it('succeeds and updates acknowledged_at on a second acknowledge call on the same alert', async () => {
      const targetAlertId = alertIds[1]!;

      // First acknowledge
      const firstRes = await acknowledgeAlert(targetAlertId, suretyToken);
      assert.strictEqual(firstRes.status, 200, 'first acknowledge should return 200');
      const firstBody = (await firstRes.json()) as AcknowledgeAlertResponse;
      assert.ok(firstBody.alert?.acknowledged_at);
      const firstAckTime = new Date(firstBody.alert.acknowledged_at).getTime();

      // Brief pause to allow timestamp increment
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second acknowledge
      const secondRes = await acknowledgeAlert(targetAlertId, suretyToken);
      assert.strictEqual(secondRes.status, 200, 'second acknowledge should return 200');
      const secondBody = (await secondRes.json()) as AcknowledgeAlertResponse;
      assert.ok(secondBody.alert?.acknowledged_at);
      const secondAckTime = new Date(secondBody.alert.acknowledged_at).getTime();

      assert.ok(
        secondAckTime >= firstAckTime,
        'second acknowledged_at timestamp must be >= first acknowledged_at timestamp'
      );
    });

    it('rejects importer-role token with 403 before the update runs', async () => {
      const targetAlertId = alertIds[2]!;

      // Confirm initial DB state: acknowledged_at is null
      const beforeDb = await pool.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM oracle_alerts WHERE id = $1',
        [targetAlertId]
      );
      assert.strictEqual(
        beforeDb.rows[0]?.acknowledged_at,
        null,
        'alert should not be acknowledged prior to call'
      );

      // Attempt acknowledge with importer token
      const response = await acknowledgeAlert(targetAlertId, importerToken);
      assert.strictEqual(response.status, 403, 'importer token should receive 403');
      const body = (await response.json()) as AcknowledgeAlertResponse;
      assert.strictEqual(body.error, 'surety admin only');

      // Verify that database row was NOT updated
      const afterDb = await pool.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM oracle_alerts WHERE id = $1',
        [targetAlertId]
      );
      assert.strictEqual(
        afterDb.rows[0]?.acknowledged_at,
        null,
        'database row must remain unacknowledged after 403'
      );
    });

    it('rejects unauthenticated acknowledge request with 401', async () => {
      const targetAlertId = alertIds[0]!;
      const response = await acknowledgeAlert(targetAlertId);
      assert.strictEqual(response.status, 401, 'unauthenticated request should return 401');
      const body = (await response.json()) as AcknowledgeAlertResponse;
      assert.strictEqual(body.error, 'missing bearer token');
    });
  });
});
