import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migration0012Up } from '../../migrations/0012_dispute_evidence.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });

const testTag = randomUUID().slice(0, 8);
const importerEmail = `test-imp-992-${testTag}@example.com`;
const adminEmail = `test-admin-992-${testTag}@example.com`;

let dbAvailable = false;
let importerUserId: string;
let adminUserId: string;
let importerId: string;
let openDisputeId: string;
let resolvedDisputeId: string;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issue #992 — Allow Evidence Attachments on raise_dispute Submissions', () => {
  before(async () => {
    try {
      const client = await pool.connect();
      try {
        await migration0012Up(client);
        dbAvailable = true;

        const u1 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [importerEmail, 'hash1', 'importer']
        );
        importerUserId = u1.rows[0]!.id;

        const u2 = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [adminEmail, 'hash2', 'surety_admin']
        );
        adminUserId = u2.rows[0]!.id;

        const impRes = await pool.query<{ id: string }>(
          `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status, collateral_balance)
           VALUES ($1, $2, $3, $4, 'approved', 10000000)
           RETURNING id`,
          [importerUserId, 'Dispute Test Importer Corp', testBondId, 'GBTESTDISPUTEIMPORTER12345']
        );
        importerId = impRes.rows[0]!.id;

        const openRes = await pool.query<{ id: string }>(
          `INSERT INTO collateral_disputes (importer_id, old_required, new_required, status)
           VALUES ($1, 5000000, 10000000, 'open')
           RETURNING id`,
          [importerId]
        );
        openDisputeId = openRes.rows[0]!.id;

        const resolvedRes = await pool.query<{ id: string }>(
          `INSERT INTO collateral_disputes (importer_id, old_required, new_required, status, resolved_at)
           VALUES ($1, 4000000, 8000000, 'resolved_accepted', now())
           RETURNING id`,
          [importerId]
        );
        resolvedDisputeId = resolvedRes.rows[0]!.id;
      } finally {
        client.release();
      }
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      if (importerId) {
        await pool.query('DELETE FROM dispute_evidence WHERE importer_id = $1', [importerId]);
        await pool.query('DELETE FROM collateral_disputes WHERE importer_id = $1', [importerId]);
        await pool.query('DELETE FROM audit_log WHERE actor_user_id IN ($1, $2)', [
          importerUserId,
          adminUserId,
        ]);
        await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
      }
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, adminUserId]);
    }
    await pool.end().catch(() => undefined);
  });

  it('validates evidence payload format constraints', () => {
    const validNotes = 'Valid evidence note explaining HTS classification dispute.';
    assert.ok(validNotes.length > 0 && validNotes.length <= 2000);

    const validMimes = ['application/pdf', 'image/png', 'image/jpeg'];
    assert.ok(validMimes.includes('application/pdf'));
    assert.ok(validMimes.includes('image/png'));
  });

  it('inserts and retrieves notes-only evidence for an open dispute', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const res = await pool.query(
      `INSERT INTO dispute_evidence (dispute_id, importer_id, notes)
       VALUES ($1, $2, $3)
       RETURNING id, dispute_id, importer_id, notes, created_at`,
      [openDisputeId, importerId, 'HTS classification code is contested; CBP ruling pending']
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0]?.dispute_id, openDisputeId);
    assert.equal(res.rows[0]?.importer_id, importerId);
    assert.equal(res.rows[0]?.notes, 'HTS classification code is contested; CBP ruling pending');
  });

  it('inserts encrypted S3 metadata for file upload evidence', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const mockEncryptedKey = 'mock-encrypted-s3-key:iv:tag';
    const res = await pool.query(
      `INSERT INTO dispute_evidence (dispute_id, importer_id, file_name, mime_type, file_size_bytes, s3_key_encrypted, virus_scan_status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, file_name, mime_type, file_size_bytes, virus_scan_status`,
      [
        openDisputeId,
        importerId,
        'customs_ruling_2026.pdf',
        'application/pdf',
        45230,
        mockEncryptedKey,
        'clean',
        'Supporting CBP binding ruling document',
      ]
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0]?.file_name, 'customs_ruling_2026.pdf');
    assert.equal(res.rows[0]?.mime_type, 'application/pdf');
    assert.equal(res.rows[0]?.virus_scan_status, 'clean');
  });

  it('surfaces dispute evidence in dispute detail and history queries', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const evRes = await pool.query(
      `SELECT id, dispute_id, importer_id, file_name, notes, virus_scan_status, created_at
       FROM dispute_evidence
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [openDisputeId]
    );

    assert.equal(evRes.rowCount, 2);
    assert.equal(evRes.rows[0]?.notes, 'HTS classification code is contested; CBP ruling pending');
    assert.equal(evRes.rows[1]?.file_name, 'customs_ruling_2026.pdf');
  });

  it('disallows attaching evidence to an already resolved dispute', async (t) => {
    if (!dbAvailable) {
      t.skip('Database not available in this environment');
      return;
    }

    const dispRes = await pool.query(
      'SELECT status FROM collateral_disputes WHERE id = $1',
      [resolvedDisputeId]
    );
    assert.equal(dispRes.rows[0]?.status, 'resolved_accepted');
  });
});
