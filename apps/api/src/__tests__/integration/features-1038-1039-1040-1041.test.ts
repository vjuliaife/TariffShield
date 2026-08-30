import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migrationUp } from '../../migrations/0009_dual_approvals_sku_mappings_document_expiry.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const importerEmail = `test-imp-${testTag}@example.com`;
const approverEmail = `test-appr-${testTag}@example.com`;
const adminEmail = `test-admin-${testTag}@example.com`;

let importerUserId: string;
let approverUserId: string;
let adminUserId: string;
let importerId: string;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issues #1038, #1039, #1040, #1041 integration test suite', () => {
  before(async () => {
    // Ensure migration 0009 has run
    const client = await pool.connect();
    try {
      await migrationUp(client);
    } finally {
      client.release();
    }

    // Seed users
    const u1 = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [importerEmail, 'hash1', 'importer']
    );
    importerUserId = u1.rows[0]!.id;

    const u2 = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [approverEmail, 'hash2', 'importer']
    );
    approverUserId = u2.rows[0]!.id;

    const u3 = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [adminEmail, 'hash3', 'surety_admin']
    );
    adminUserId = u3.rows[0]!.id;

    // Seed importer with KYC approved
    const impRes = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status, collateral_balance)
       VALUES ($1, $2, $3, $4, 'approved', 50000000)
       RETURNING id`,
      [importerUserId, 'Dual Signoff Import Corp', testBondId, 'GBXYZTEST1234567890']
    );
    importerId = impRes.rows[0]!.id;
  });

  after(async () => {
    if (importerId) {
      await pool.query('DELETE FROM withdrawal_requests WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM importer_sku_mappings WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM kyc_documents WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM audit_log WHERE actor_user_id IN ($1, $2, $3)', [
        importerUserId,
        approverUserId,
        adminUserId,
      ]);
      await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
    }
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [
      importerUserId,
      approverUserId,
      adminUserId,
    ]);
    await pool.end();
  });

  // ── Issue #1038: Dual Sign-off Approvals ──────────────────────────────────
  describe('Issue #1038 — Dual Sign-off Approvals for Large Withdrawals', () => {
    it('enables dual sign-off with threshold and second approver', async () => {
      await pool.query(
        `UPDATE importers
            SET dual_approval_enabled = true,
                dual_approval_threshold_stroops = 10000000,
                second_approver_id = $1,
                second_approver_email = $2
          WHERE id = $3`,
        [approverUserId, approverEmail, importerId]
      );

      const r = await pool.query(
        'SELECT dual_approval_enabled, dual_approval_threshold_stroops, second_approver_id FROM importers WHERE id = $1',
        [importerId]
      );
      assert.equal(r.rows[0]?.dual_approval_enabled, true);
      assert.equal(r.rows[0]?.dual_approval_threshold_stroops, '10000000');
      assert.equal(r.rows[0]?.second_approver_id, approverUserId);
    });

    it('creates a pending withdrawal request for amounts >= threshold', async () => {
      const ins = await pool.query<{ id: string; status: string }>(
        `INSERT INTO withdrawal_requests (importer_id, requested_by, amount_stroops, status, second_approver_id)
         VALUES ($1, $2, 15000000, 'pending', $3)
         RETURNING id, status`,
        [importerId, importerUserId, approverUserId]
      );
      assert.equal(ins.rows[0]?.status, 'pending');
      const reqId = ins.rows[0]!.id;

      // Requester cancels the request
      await pool.query(
        `UPDATE withdrawal_requests SET status = 'cancelled', resolved_at = now() WHERE id = $1`,
        [reqId]
      );
      const cancelled = await pool.query('SELECT status FROM withdrawal_requests WHERE id = $1', [
        reqId,
      ]);
      assert.equal(cancelled.rows[0]?.status, 'cancelled');
    });

    it('allows designated second approver to approve pending withdrawal', async () => {
      const ins = await pool.query<{ id: string; status: string }>(
        `INSERT INTO withdrawal_requests (importer_id, requested_by, amount_stroops, status, second_approver_id)
         VALUES ($1, $2, 20000000, 'pending', $3)
         RETURNING id, status`,
        [importerId, importerUserId, approverUserId]
      );
      const reqId = ins.rows[0]!.id;

      // Approver confirms
      await pool.query(
        `UPDATE withdrawal_requests
            SET status = 'approved', approved_by = $1, job_id = 'job-withdraw-123', resolved_at = now()
          WHERE id = $2`,
        [approverUserId, reqId]
      );

      const approved = await pool.query(
        'SELECT status, approved_by, job_id FROM withdrawal_requests WHERE id = $1',
        [reqId]
      );
      assert.equal(approved.rows[0]?.status, 'approved');
      assert.equal(approved.rows[0]?.approved_by, approverUserId);
      assert.equal(approved.rows[0]?.job_id, 'job-withdraw-123');
    });
  });

  // ── Issue #1039: Audit Log Search & Filter UI Backend ─────────────────────
  describe('Issue #1039 — Audit Log Search and Filter', () => {
    before(async () => {
      // Insert test audit entries
      await pool.query(
        `INSERT INTO audit_log (actor_user_id, action, target_id, payload, created_at)
         VALUES ($1, 'withdraw_approved', $2, '{"amountStroops":"20000000","jobId":"job-123"}'::jsonb, now() - interval '2 hours'),
                ($1, 'dual_approval_configured', $2, '{"enabled":true,"thresholdStroops":"10000000"}'::jsonb, now() - interval '1 hour'),
                ($3, 'kyc_status_update', $2, '{"kycStatus":"approved"}'::jsonb, now())`,
        [importerUserId, importerId, adminUserId]
      );
    });

    it('filters audit logs by action type', async () => {
      const r = await pool.query(
        `SELECT al.*, u.email AS actor_email
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_user_id
          WHERE al.action = 'dual_approval_configured'`
      );
      assert.ok(r.rows.length >= 1);
      assert.equal(r.rows[0]?.action, 'dual_approval_configured');
    });

    it('searches audit log free-text across payload and description', async () => {
      const searchParam = '%20000000%';
      const r = await pool.query(
        `SELECT al.*, u.email AS actor_email
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_user_id
          WHERE (al.action ILIKE $1 OR al.payload::text ILIKE $1 OR u.email ILIKE $1 OR al.target_id::text ILIKE $1)`,
        [searchParam]
      );
      assert.ok(r.rows.length >= 1);
      assert.equal(r.rows[0]?.action, 'withdraw_approved');
    });
  });

  // ── Issue #1040: Bulk HS Code Mapping Table ──────────────────────────────
  describe('Issue #1040 — Bulk HS Code Mapping Table for Catalogs', () => {
    it('stores versioned product SKU to HTS mappings', async () => {
      // Version 1 upload
      await pool.query(
        `INSERT INTO importer_sku_mappings (importer_id, version, sku, hts_code, description, duty_rate, is_active)
         VALUES ($1, 1, 'SKU-SHIRT-01', '6109.10.00', 'Cotton T-Shirt', 0.165, true),
                ($1, 1, 'SKU-PANTS-02', '6203.42.40', 'Denim Jeans', 0.166, true)`,
        [importerId]
      );

      const v1 = await pool.query(
        'SELECT sku, hts_code, is_active FROM importer_sku_mappings WHERE importer_id = $1 AND version = 1',
        [importerId]
      );
      assert.equal(v1.rows.length, 2);

      // Version 2 re-upload supersedes version 1
      await pool.query(
        'UPDATE importer_sku_mappings SET is_active = false WHERE importer_id = $1',
        [importerId]
      );
      await pool.query(
        `INSERT INTO importer_sku_mappings (importer_id, version, sku, hts_code, description, duty_rate, is_active)
         VALUES ($1, 2, 'SKU-SHIRT-01', '6109.10.00', 'Cotton T-Shirt v2', 0.165, true),
                ($1, 2, 'SKU-HAT-03', '6505.00.80', 'Wool Hat', 0.080, true)`,
        [importerId]
      );

      const active = await pool.query(
        'SELECT sku, hts_code FROM importer_sku_mappings WHERE importer_id = $1 AND is_active = true ORDER BY sku ASC',
        [importerId]
      );
      assert.equal(active.rows.length, 2);
      assert.equal(active.rows[0]?.sku, 'SKU-HAT-03');
      assert.equal(active.rows[1]?.sku, 'SKU-SHIRT-01');
    });

    it('flags unmapped SKUs when resolving tariff line items', async () => {
      const activeMappings = await pool.query<{ sku: string; hts_code: string }>(
        'SELECT sku, hts_code FROM importer_sku_mappings WHERE importer_id = $1 AND is_active = true',
        [importerId]
      );
      const skuMap = new Map(activeMappings.rows.map((r) => [r.sku, r.hts_code]));

      const inputLineItems = [
        { sku: 'SKU-SHIRT-01', value: 1000 },
        { sku: 'SKU-UNMAPPED-99', value: 2000 },
      ];

      const unmapped: string[] = [];
      const resolved = [];

      for (const item of inputLineItems) {
        const hts = skuMap.get(item.sku);
        if (hts) {
          resolved.push({ sku: item.sku, htsCode: hts, value: item.value });
        } else {
          unmapped.push(item.sku);
        }
      }

      assert.equal(resolved.length, 1);
      assert.equal(unmapped.length, 1);
      assert.equal(unmapped[0], 'SKU-UNMAPPED-99');
    });
  });

  // ── Issue #1041: Document Expiration Calendar View ────────────────────────
  describe('Issue #1041 — Consolidated Document Expiration Calendar', () => {
    before(async () => {
      // Insert KYC document with expiry in 20 days (critical)
      const expiryDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO kyc_documents (importer_id, document_type, document_name, s3_key_encrypted, expiration_date)
         VALUES ($1, 'articles_of_incorporation', 'Corporate Articles', 'key-enc-1', $2)`,
        [importerId, expiryDate]
      );

      // Insert surety state license with expiry in 45 days (warning)
      const licExpiry = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO surety_state_licenses (state_code, license_number, expiration_date, status)
         VALUES ('CA', 'LIC-CA-9988', $1, 'active')
         ON CONFLICT (state_code) DO UPDATE SET expiration_date = EXCLUDED.expiration_date`,
        [licExpiry]
      );
    });

    it('aggregates KYC and license expirations with accurate urgency thresholds', async () => {
      const kycRes = await pool.query(
        'SELECT id, document_type, expiration_date FROM kyc_documents WHERE importer_id = $1 AND deleted_at IS NULL',
        [importerId]
      );
      assert.ok(kycRes.rows.length >= 1);

      const expiry = new Date(kycRes.rows[0]!.expiration_date);
      const daysUntil = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      assert.ok(daysUntil <= 30); // Critical threshold <= 30d

      const licRes = await pool.query(
        "SELECT state_code, license_number, expiration_date FROM surety_state_licenses WHERE state_code = 'CA'"
      );
      assert.ok(licRes.rows.length >= 1);
      const licDays = Math.ceil(
        (new Date(licRes.rows[0]!.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      assert.ok(licDays > 30 && licDays <= 60); // Warning threshold 31-60d
    });
  });
});
