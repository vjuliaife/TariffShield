import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

process.env.FIELD_ENCRYPTION_KEY ??= 'integration-test-field-encryption-key-32-chars';

const { privacyRouter } = await import('../../routes/privacy.js');
const { kycRouter, s3KeyEncrypt } = await import('../../routes/kyc.js');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';
const pool = new Pool({ connectionString: DATABASE_URL });
const tag = randomUUID().slice(0, 8);

type CapturedResponse = { statusCode: number; body: unknown };

function response(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined };
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

function routeHandler(router: any, path: string, method: string) {
  const layer = (router.stack as any[]).find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} route must be registered`);
  return layer.route.stack.at(-1).handle;
}

async function createUser(role: 'importer' | 'surety_admin', suffix: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3) RETURNING id`,
    [`feature-629-632-${suffix}-${tag}@example.com`, 'integration-test-hash', role]
  );
  return result.rows[0]!.id;
}

async function createImporter(userId: string, suffix: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      userId,
      `Feature ${suffix} Corp`,
      Math.floor(Math.random() * 9_000_000) + 1_000_000,
      `G${suffix.toUpperCase().padEnd(55, 'X').slice(0, 55)}`,
    ]
  );
  return result.rows[0]!.id;
}

describe('KYC download and privacy acceptance integrations (#629, #630, #631, #632)', () => {
  let ownerId: string;
  let otherUserId: string;
  let adminId: string;
  let ownerImporterId: string;
  let otherImporterId: string;
  let documentId: string;
  const policyVersion = `feature-629-632-${tag}`;

  before(async () => {
    ownerId = await createUser('importer', 'owner');
    otherUserId = await createUser('importer', 'other');
    adminId = await createUser('surety_admin', 'admin');
    ownerImporterId = await createImporter(ownerId, 'owner');
    otherImporterId = await createImporter(otherUserId, 'other');

    const document = await pool.query<{ id: string }>(
      `INSERT INTO kyc_documents
         (importer_id, document_type, s3_key_encrypted, scheduled_deletion_date)
       VALUES ($1, 'ein_confirmation', $2, now() + interval '7 years')
       RETURNING id`,
      [ownerImporterId, s3KeyEncrypt(`kyc/${ownerImporterId}/document.pdf`)]
    );
    documentId = document.rows[0]!.id;

    await pool.query(
      `INSERT INTO privacy_policy_versions
         (version_id, effective_date, change_summary, requires_reacceptance)
       VALUES ($1, CURRENT_DATE, 'integration test policy', TRUE)`,
      [policyVersion]
    );
    await pool.query('UPDATE users SET privacy_reacceptance_required = TRUE WHERE id = $1', [
      ownerId,
    ]);
  });

  after(async () => {
    await pool.query('DELETE FROM privacy_policy_acceptances WHERE policy_version_id = $1', [
      policyVersion,
    ]);
    await pool.query('DELETE FROM privacy_policy_versions WHERE version_id = $1', [policyVersion]);
    await pool.query('DELETE FROM kyc_documents WHERE id = $1', [documentId]);
    await pool.query('DELETE FROM importers WHERE id IN ($1, $2)', [
      ownerImporterId,
      otherImporterId,
    ]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [ownerId, otherUserId, adminId]);
    await pool.end();
  });

  it('#630 returns a presigned download URL and its expiry for the document owner', async () => {
    const download = routeHandler(kycRouter, '/:id/kyc/:docId/download', 'get');
    const { res, captured } = response();

    await download(
      {
        params: { id: ownerImporterId, docId: documentId },
        user: { id: ownerId, role: 'importer' },
      },
      res
    );

    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, {
      url: `/dev/kyc-stub/kyc/${ownerImporterId}/document.pdf`,
      expiresInSeconds: 900,
    });
  });

  it('#629 scopes document downloads to the owning importer or surety admin', async () => {
    const download = routeHandler(kycRouter, '/:id/kyc/:docId/download', 'get');

    const unauthorized = response();
    await download(
      {
        params: { id: ownerImporterId, docId: documentId },
        user: { id: otherUserId, role: 'importer' },
      },
      unauthorized.res
    );
    assert.equal(unauthorized.captured.statusCode, 404);
    assert.deepEqual(unauthorized.captured.body, { error: 'not found' });

    const admin = response();
    await download(
      {
        params: { id: ownerImporterId, docId: documentId },
        user: { id: adminId, role: 'surety_admin' },
      },
      admin.res
    );
    assert.equal(admin.captured.statusCode, 200);

    await pool.query('UPDATE kyc_documents SET deleted_at = now() WHERE id = $1', [documentId]);
    const deleted = response();
    await download(
      {
        params: { id: ownerImporterId, docId: documentId },
        user: { id: ownerId, role: 'importer' },
      },
      deleted.res
    );
    assert.equal(deleted.captured.statusCode, 404);
    await pool.query('UPDATE kyc_documents SET deleted_at = NULL WHERE id = $1', [documentId]);
  });

  it('#630 returns a distinguishable placeholder URL for corrupt ciphertext', async () => {
    const download = routeHandler(kycRouter, '/:id/kyc/:docId/download', 'get');
    const corrupt = JSON.stringify({ ciphertext: 'bad', iv: 'bad', tag: 'bad', key_version: 1 });
    await pool.query('UPDATE kyc_documents SET s3_key_encrypted = $1 WHERE id = $2', [
      corrupt,
      documentId,
    ]);
    const { res, captured } = response();

    await download(
      {
        params: { id: ownerImporterId, docId: documentId },
        user: { id: ownerId, role: 'importer' },
      },
      res
    );

    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, {
      url: '/dev/kyc-stub/[decryption error]',
      expiresInSeconds: 900,
    });
    await pool.query('UPDATE kyc_documents SET s3_key_encrypted = $1 WHERE id = $2', [
      s3KeyEncrypt(`kyc/${ownerImporterId}/document.pdf`),
      documentId,
    ]);
  });

  it('#631 accepts a valid privacy version and clears the reacceptance flag', async () => {
    const accept = routeHandler(privacyRouter, '/accept-privacy-policy', 'post');
    const { res, captured } = response();

    await accept(
      { body: { versionId: policyVersion }, ip: '127.0.0.1', user: { id: ownerId } },
      res
    );

    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, { accepted: true, versionId: policyVersion });

    const user = await pool.query<{ privacy_reacceptance_required: boolean }>(
      'SELECT privacy_reacceptance_required FROM users WHERE id = $1',
      [ownerId]
    );
    assert.equal(user.rows[0]!.privacy_reacceptance_required, false);

    const acceptance = await pool.query(
      `SELECT acceptance_channel, ip_address
         FROM privacy_policy_acceptances
        WHERE user_id = $1 AND policy_version_id = $2`,
      [ownerId, policyVersion]
    );
    assert.deepEqual(acceptance.rows, [{ acceptance_channel: 'in_app', ip_address: '127.0.0.1' }]);

    await accept(
      { body: { versionId: policyVersion }, ip: '127.0.0.1', user: { id: ownerId } },
      res
    );
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM privacy_policy_acceptances WHERE user_id = $1 AND policy_version_id = $2',
      [ownerId, policyVersion]
    );
    assert.equal(Number(count.rows[0]!.count), 1);

    const history = routeHandler(privacyRouter, '/privacy-policy-history', 'get');
    const historyResponse = response();
    await history({ user: { id: ownerId } }, historyResponse.res);
    assert.equal(
      (historyResponse.captured.body as { acceptances: { policy_version_id: string }[] })
        .acceptances[0]?.policy_version_id,
      policyVersion
    );
  });

  it('#632 returns 404 for an unknown privacy version without changing the flag', async () => {
    await pool.query('UPDATE users SET privacy_reacceptance_required = TRUE WHERE id = $1', [
      ownerId,
    ]);
    const accept = routeHandler(privacyRouter, '/accept-privacy-policy', 'post');
    const { res, captured } = response();

    await accept(
      { body: { versionId: `${policyVersion}-missing` }, ip: '127.0.0.1', user: { id: ownerId } },
      res
    );

    assert.equal(captured.statusCode, 404);
    assert.deepEqual(captured.body, { error: 'policy version not found' });

    const user = await pool.query<{ privacy_reacceptance_required: boolean }>(
      'SELECT privacy_reacceptance_required FROM users WHERE id = $1',
      [ownerId]
    );
    assert.equal(user.rows[0]!.privacy_reacceptance_required, true);
  });

  it('#632 rejects a missing versionId before querying policy versions', async () => {
    const accept = routeHandler(privacyRouter, '/accept-privacy-policy', 'post');
    const { res, captured } = response();

    await accept({ body: {}, ip: '127.0.0.1', user: { id: ownerId } }, res);

    assert.equal(captured.statusCode, 400);
    assert.deepEqual(captured.body, { error: 'versionId is required' });
  });
});
