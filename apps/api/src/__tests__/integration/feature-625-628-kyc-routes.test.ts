import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

process.env.FIELD_ENCRYPTION_KEY ??= 'integration-test-field-encryption-key-32-chars';

const { pool } = await import('../../db.js');
const { kycRouter, s3KeyEncrypt } = await import('../../routes/kyc.js');
const { decryptFieldFromJson } = await import('../../lib/field-encryption.js');

const tag = randomUUID().slice(0, 8);
const testPool = pool as Pool;

type Captured = { statusCode: number; body: any };

function response(): { res: any; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

function handler(path: string, method: string): any {
  const layer = (kycRouter.stack as any[]).find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack.at(-1).handle;
}

async function createUser(role: 'importer' | 'surety_admin', suffix: string) {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
    [`feature-625-628-${suffix}-${tag}@example.com`, 'integration-test-hash', role]
  );
  return result.rows[0]!.id;
}

async function createImporter(userId: string, suffix: string) {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      userId,
      `KYC route ${suffix} ${tag}`,
      Math.floor(Math.random() * 9_000_000) + 1_000_000,
      `G${randomUUID().replace(/-/g, '').padEnd(55, 'X').slice(0, 55)}`,
    ]
  );
  return result.rows[0]!.id;
}

async function invoke(
  path: string,
  method: string,
  params: Record<string, string>,
  user: any,
  body?: any
) {
  const { res, captured } = response();
  await handler(path, method)({ params, user, body }, res);
  return captured;
}

describe('KYC route integrations (#625, #626, #627, #628)', () => {
  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let importerId: string;
  let otherImporterId: string;
  const documentIds: string[] = [];

  before(async () => {
    ownerId = await createUser('importer', 'owner');
    otherId = await createUser('importer', 'other');
    adminId = await createUser('surety_admin', 'admin');
    importerId = await createImporter(ownerId, 'owner');
    otherImporterId = await createImporter(otherId, 'other');
  });

  after(async () => {
    await testPool.query('DELETE FROM kyc_documents WHERE importer_id = ANY($1::uuid[])', [
      [importerId, otherImporterId],
    ]);
    await testPool.query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [
      [importerId, otherImporterId],
    ]);
    await testPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [ownerId, otherId, adminId],
    ]);
    await testPool.end();
  });

  it('#625 rejects unsupported mime types and document types without side effects, then accepts PDF', async () => {
    const upload = handler('/:id/kyc', 'post');
    const base = {
      documentType: 'ein_confirmation',
      fileBase64: Buffer.from('%PDF-test').toString('base64'),
      fileName: 'id.pdf',
    };
    const unsupported = await invoke(
      '/:id/kyc',
      'post',
      { id: importerId },
      { id: ownerId, role: 'importer' },
      { ...base, mimeType: 'text/plain' }
    );
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.body.error, 'invalid input');
    assert.ok(Array.isArray(unsupported.body.details));

    const badType = await invoke(
      '/:id/kyc',
      'post',
      { id: importerId },
      { id: ownerId, role: 'importer' },
      { ...base, mimeType: 'application/pdf', documentType: 'not-a-document-type' }
    );
    assert.equal(badType.statusCode, 400);
    assert.equal(
      (
        await testPool.query('SELECT COUNT(*) FROM kyc_documents WHERE importer_id = $1', [
          importerId,
        ])
      ).rows[0].count,
      '0'
    );

    const valid = await invoke(
      '/:id/kyc',
      'post',
      { id: importerId },
      { id: ownerId, role: 'importer' },
      { ...base, mimeType: 'application/pdf' }
    );
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.body.document.document_type, 'ein_confirmation');
    documentIds.push(valid.body.document.id);
    void upload;
  });

  it('#626 stores an encrypted S3 key and five-year retention date', async () => {
    const beforeUpload = Date.now();
    const result = await invoke(
      '/:id/kyc',
      'post',
      { id: otherImporterId },
      { id: otherId, role: 'importer' },
      {
        documentType: 'passport',
        mimeType: 'application/pdf',
        fileBase64: Buffer.from('%PDF-test').toString('base64'),
        fileName: 'passport.pdf',
      }
    );
    assert.equal(result.statusCode, 201);
    const row = (
      await testPool.query(
        'SELECT s3_key_encrypted, scheduled_deletion_date FROM kyc_documents WHERE id = $1',
        [result.body.document.id]
      )
    ).rows[0];
    documentIds.push(result.body.document.id);
    const envelope = JSON.parse(row.s3_key_encrypted);
    assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'key_version', 'tag']);
    const plaintext = decryptFieldFromJson(row.s3_key_encrypted);
    assert.match(plaintext, new RegExp(`^kyc/${otherImporterId}/passport/`));
    assert.ok(!row.s3_key_encrypted.includes(plaintext));
    const retention = new Date(row.scheduled_deletion_date).getTime();
    assert.ok(retention - beforeUpload > 364 * 24 * 60 * 60 * 1000);
  });

  it('#627 excludes deleted documents, orders newest first, and enforces importer ownership', async () => {
    const old = await testPool.query<{ id: string }>(
      `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, upload_timestamp) VALUES ($1, 'passport', $2, now() - interval '1 day') RETURNING id`,
      [importerId, s3KeyEncrypt('kyc/old')]
    );
    const deleted = await testPool.query<{ id: string }>(
      `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, deleted_at) VALUES ($1, 'ein_confirmation', $2, now()) RETURNING id`,
      [importerId, s3KeyEncrypt('kyc/deleted')]
    );
    const fresh = await testPool.query<{ id: string }>(
      `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted) VALUES ($1, 'passport', $2) RETURNING id`,
      [importerId, s3KeyEncrypt('kyc/fresh')]
    );
    documentIds.push(old.rows[0]!.id, deleted.rows[0]!.id, fresh.rows[0]!.id);
    const listed = await invoke(
      '/:id/kyc',
      'get',
      { id: importerId },
      { id: adminId, role: 'surety_admin' }
    );
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.documents.length, 2);
    assert.equal(listed.body.documents[0].id, fresh.rows[0]!.id);
    assert.equal(listed.body.documents[1].id, old.rows[0]!.id);
    const forbidden = await invoke(
      '/:id/kyc',
      'get',
      { id: importerId },
      { id: otherId, role: 'importer' }
    );
    assert.equal(forbidden.statusCode, 404);
  });

  it('#628 derives rejected before approved before pending and rejects mismatched documents', async () => {
    const a = await testPool.query<{ id: string }>(
      `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, review_status) VALUES ($1, 'passport', $2, 'approved') RETURNING id`,
      [importerId, s3KeyEncrypt('kyc/a')]
    );
    const b = await testPool.query<{ id: string }>(
      `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, review_status) VALUES ($1, 'ein_confirmation', $2, 'pending') RETURNING id`,
      [importerId, s3KeyEncrypt('kyc/b')]
    );
    documentIds.push(a.rows[0]!.id, b.rows[0]!.id);
    let result = await invoke(
      '/:id/kyc/:docId/review',
      'post',
      { id: importerId, docId: a.rows[0]!.id },
      { id: adminId, role: 'surety_admin' },
      { decision: 'approved', note: 'verified' }
    );
    assert.equal(result.body.importerKycStatus, 'approved');
    result = await invoke(
      '/:id/kyc/:docId/review',
      'post',
      { id: importerId, docId: b.rows[0]!.id },
      { id: adminId, role: 'surety_admin' },
      { decision: 'rejected', note: 'failed verification' }
    );
    assert.equal(result.body.importerKycStatus, 'rejected');
    const mismatch = await invoke(
      '/:id/kyc/:docId/review',
      'post',
      { id: otherImporterId, docId: a.rows[0]!.id },
      { id: adminId, role: 'surety_admin' },
      { decision: 'approved', note: 'wrong importer' }
    );
    assert.equal(mismatch.statusCode, 404);
  });
});
