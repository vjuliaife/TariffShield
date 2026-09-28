import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool, logAudit } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { encryptFieldToJson, decryptFieldFromJson } from '../lib/field-encryption.js';
import { env } from '../config/env.js';

export const kycRouter = Router();
kycRouter.use(authMiddleware);
kycRouter.use(privacyReacceptanceGate);
kycRouter.use(tosReacceptanceGate);

// BSA requires 5-year retention from last transaction; we track scheduled_deletion_date.
// In production, S3 keys are stored encrypted; actual documents never touch the DB.

const BSA_RETENTION_DAYS = 5 * 365;

export function s3KeyEncrypt(key: string): string {
  return encryptFieldToJson(key) ?? key;
}

export function s3KeyDecrypt(encrypted: string): string {
  try {
    return decryptFieldFromJson(encrypted) ?? encrypted;
  } catch {
    return '[decryption error]';
  }
}

// Stub: in production, use AWS SDK PutObjectCommand to S3_KYC_BUCKET with SSE-KMS.
// Returns the S3 object key for the uploaded document.
export async function uploadDocumentToS3(
  importerId: string,
  documentType: string,
  _fileBuffer: Buffer,
  _mimeType: string
): Promise<string> {
  const timestamp = Date.now();
  const key = `kyc/${importerId}/${documentType}/${timestamp}`;
  if (env.S3_KYC_BUCKET) {
    // Production: AWS SDK upload would go here
    // const s3 = new S3Client({ region: env.AWS_REGION });
    // await s3.send(new PutObjectCommand({ Bucket: env.S3_KYC_BUCKET, Key: key, Body: fileBuffer, ContentType: mimeType, ServerSideEncryption: "aws:kms" }));
  }
  return key;
}

// Stub: in production, generate a pre-signed GetObjectCommand URL with 15-min TTL.
export function generatePresignedUrl(s3Key: string): string {
  if (env.S3_KYC_BUCKET) {
    return `https://${env.S3_KYC_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${s3Key}?presigned=stub`;
  }
  return `/dev/kyc-stub/${s3Key}`;
}

const KycDocumentTypeSchema = z.enum([
  'articles_of_incorporation',
  'ein_confirmation',
  'beneficial_ownership_fincen_102',
]);

// In production, file bytes come from multipart/form-data (multer/busboy).
// For now, accept a base64-encoded payload for API simplicity. The 500 KB
// per-file cap keeps a full batch comfortably inside the global 1 MB
// express.json body limit (index.ts).
export const KYC_MAX_FILE_BYTES = 500 * 1024;
const KYC_BATCH_MAX_FILES = 10;

const UploadKycFileSchema = z.object({
  documentType: KycDocumentTypeSchema,
  fileBase64: z.string().min(1),
  mimeType: z.string().regex(/^(application\/pdf|image\/(png|jpeg))$/),
  fileName: z.string().max(255).optional(),
});

const UploadKycSchema = UploadKycFileSchema;

const UploadKycBatchSchema = z.object({
  documents: z.array(UploadKycFileSchema).min(1).max(KYC_BATCH_MAX_FILES),
});

export type VirusScanStatus = 'pending' | 'clean' | 'infected';

// Lightweight inline virus/content scan (#1006). Detects the EICAR
// anti-malware test string and validates the file's magic bytes against the
// declared MIME type. A buffer that neither trips a signature nor matches a
// known header is left 'pending' for an external scanner rather than being
// cleared — surfacing as `virus-scan-pending` in the batch response.
export function scanDocumentBuffer(buffer: Buffer, mimeType: string): VirusScanStatus {
  const eicar = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    'latin1'
  );
  if (buffer.includes(eicar)) return 'infected';

  const startsWith = (sig: Buffer): boolean =>
    buffer.length >= sig.length && buffer.subarray(0, sig.length).equals(sig);

  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? 'clean' : 'pending';
  }
  if (mimeType === 'image/png') {
    return startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'clean' : 'pending';
  }
  if (mimeType === 'image/jpeg') {
    return startsWith(Buffer.from([0xff, 0xd8, 0xff])) ? 'clean' : 'pending';
  }
  return 'pending';
}

interface StoredKycDocument {
  document: Record<string, unknown>;
  virusScanStatus: VirusScanStatus;
}

class KycUploadError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Shared storage path for the single-file (#312) and batch (#1006) upload
// endpoints — validation, scanning, S3 stub, encryption and insert live here
// so both routes stay behaviourally identical.
async function storeKycDocument(
  importerId: string,
  file: z.infer<typeof UploadKycFileSchema>
): Promise<StoredKycDocument> {
  const fileBuffer = Buffer.from(file.fileBase64, 'base64');
  if (fileBuffer.length === 0) {
    throw new KycUploadError(400, 'file is empty');
  }
  if (fileBuffer.length > KYC_MAX_FILE_BYTES) {
    throw new KycUploadError(413, `file exceeds ${KYC_MAX_FILE_BYTES} byte limit`);
  }

  const virusScanStatus = scanDocumentBuffer(fileBuffer, file.mimeType);
  if (virusScanStatus === 'infected') {
    throw new KycUploadError(422, 'virus detected in uploaded document');
  }

  const s3Key = await uploadDocumentToS3(importerId, file.documentType, fileBuffer, file.mimeType);
  const encryptedKey = s3KeyEncrypt(s3Key);

  // BSA minimum 5-year retention from upload; updated when importer has a transaction.
  const scheduledDeletion = new Date(Date.now() + BSA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, scheduled_deletion_date,
                                document_name, virus_scan_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, document_type, upload_timestamp, review_status, scheduled_deletion_date,
               document_name, virus_scan_status`,
    [
      importerId,
      file.documentType,
      encryptedKey,
      scheduledDeletion,
      file.fileName ?? null,
      virusScanStatus,
    ]
  );

  return { document: result.rows[0], virusScanStatus };
}

// POST /api/v1/importers/:id/kyc — upload a KYC document (importer only)
kycRouter.post('/:id/kyc', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'importer') {
    res.status(403).json({ error: 'only importers can upload KYC documents' });
    return;
  }

  const imp = await pool.query('SELECT id FROM importers WHERE id = $1 AND user_id = $2', [
    req.params.id,
    user.id,
  ]);
  if (!imp.rowCount) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const importerId: string = imp.rows[0]!.id;

  const parse = UploadKycSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  try {
    const stored = await storeKycDocument(importerId, parse.data);
    await logAudit(user.id, 'kyc_document_upload', importerId, {
      documentType: parse.data.documentType,
      fileName: parse.data.fileName ?? null,
      virusScanStatus: stored.virusScanStatus,
    });
    res.status(201).json({ document: stored.document });
  } catch (err) {
    if (err instanceof KycUploadError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// POST /api/v1/importers/:id/kyc/batch — bulk drag-and-drop upload (#1006).
// Every file is processed individually so one bad file (oversized, infected,
// insert failure) never blocks the files around it — partial batch failures
// are reported per file instead of failing the whole request.
kycRouter.post('/:id/kyc/batch', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'importer') {
    res.status(403).json({ error: 'only importers can upload KYC documents' });
    return;
  }

  const imp = await pool.query('SELECT id FROM importers WHERE id = $1 AND user_id = $2', [
    req.params.id,
    user.id,
  ]);
  if (!imp.rowCount) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const importerId: string = imp.rows[0]!.id;

  const parse = UploadKycBatchSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  type BatchStatus = 'success' | 'failed' | 'virus-scan-pending';
  const results: Array<{
    index: number;
    fileName: string | null;
    documentType: z.infer<typeof KycDocumentTypeSchema>;
    status: BatchStatus;
    virusScanStatus: VirusScanStatus | null;
    document?: Record<string, unknown>;
    error?: string;
  }> = [];

  for (const [index, file] of parse.data.documents.entries()) {
    try {
      const stored = await storeKycDocument(importerId, file);
      const status: BatchStatus =
        stored.virusScanStatus === 'pending' ? 'virus-scan-pending' : 'success';
      results.push({
        index,
        fileName: file.fileName ?? null,
        documentType: file.documentType,
        status,
        virusScanStatus: stored.virusScanStatus,
        document: stored.document,
      });
    } catch (err) {
      results.push({
        index,
        fileName: file.fileName ?? null,
        documentType: file.documentType,
        status: 'failed',
        virusScanStatus: null,
        error: err instanceof Error ? err.message : 'upload failed',
      });
    }
  }

  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const pending = results.filter((r) => r.status === 'virus-scan-pending').length;

  await logAudit(user.id, 'kyc_bulk_upload', importerId, {
    total: results.length,
    succeeded,
    failed,
    pending,
    files: results.map((r) => ({
      documentType: r.documentType,
      fileName: r.fileName,
      status: r.status,
    })),
  });

  res.status(201).json({ results, succeeded, failed, pending });
});

// GET /api/v1/importers/:id/kyc — list KYC documents for an importer
kycRouter.get('/:id/kyc', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  let importerCheck;
  if (user.role === 'surety_admin') {
    importerCheck = await pool.query('SELECT id FROM importers WHERE id = $1', [req.params.id]);
  } else {
    importerCheck = await pool.query('SELECT id FROM importers WHERE id = $1 AND user_id = $2', [
      req.params.id,
      user.id,
    ]);
  }
  if (!importerCheck.rowCount) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const docs = await pool.query(
    `SELECT id, document_type, upload_timestamp, review_status, reviewed_at, reviewer_note,
            scheduled_deletion_date, deleted_at, document_name, virus_scan_status
     FROM kyc_documents WHERE importer_id = $1 AND deleted_at IS NULL
     ORDER BY upload_timestamp DESC`,
    [req.params.id]
  );
  res.json({ documents: docs.rows });
});

const UpdateKycStatusSchema = z.object({
  kycStatus: z.enum(['pending', 'approved', 'rejected']),
});

// PATCH /api/v1/importers/:id/kyc — directly set an importer's kyc_status
// (surety_admin only). This is distinct from POST /:id/kyc/:docId/review
// below, which derives kyc_status from document approvals; PATCH is a
// direct administrative override for cases handled outside the document
// workflow (e.g. KYC verified through an external channel).
kycRouter.patch('/:id/kyc', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = UpdateKycStatusSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const result = await pool.query(
    `UPDATE importers SET kyc_status = $1
     WHERE id = $2 AND deleted_at IS NULL
     RETURNING id, kyc_status`,
    [parse.data.kycStatus, req.params.id]
  );
  if (!result.rowCount) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  await logAudit(user.id, 'kyc_status_update', result.rows[0]!.id, {
    kycStatus: parse.data.kycStatus,
  });

  res.json({ importerId: result.rows[0]!.id, kycStatus: result.rows[0]!.kyc_status });
});

// POST /api/v1/importers/:id/kyc/:docId/review — surety_admin approves/rejects a document
kycRouter.post(
  '/:id/kyc/:docId/review',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;

    const parse = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'decision and note are required' });
      return;
    }
    const { decision, note } = parse.data;

    const doc = await pool.query(
      `SELECT kd.id, kd.importer_id FROM kyc_documents kd
       JOIN importers i ON i.id = kd.importer_id
       WHERE kd.id = $1 AND kd.importer_id = $2 AND kd.deleted_at IS NULL`,
      [req.params.docId, req.params.id]
    );
    if (!doc.rowCount) {
      res.status(404).json({ error: 'document not found' });
      return;
    }

    await pool.query(
      `UPDATE kyc_documents
       SET review_status = $1, reviewer_id = $2, reviewer_note = $3, reviewed_at = now()
       WHERE id = $4`,
      [decision, user.id, note, req.params.docId]
    );

    // Update importer KYC status when a document is approved/rejected.
    // Approved only when at least one document is approved and none are rejected.
    const statusResult = await pool.query(
      `SELECT
         BOOL_OR(review_status = 'approved') AS has_approved,
         BOOL_OR(review_status = 'rejected') AS has_rejected
       FROM kyc_documents WHERE importer_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    const { has_approved, has_rejected } = statusResult.rows[0] ?? {};
    const kycStatus = has_rejected ? 'rejected' : has_approved ? 'approved' : 'pending';
    await pool.query('UPDATE importers SET kyc_status = $1 WHERE id = $2', [
      kycStatus,
      req.params.id,
    ]);

    res.json({ success: true, importerKycStatus: kycStatus });
  }
);

// GET /api/v1/importers/:id/kyc/:docId/download — get a pre-signed S3 URL (surety_admin or owner)
kycRouter.get('/:id/kyc/:docId/download', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  let query;
  if (user.role === 'surety_admin') {
    query = await pool.query(
      'SELECT kd.s3_key_encrypted FROM kyc_documents kd WHERE kd.id = $1 AND kd.importer_id = $2 AND kd.deleted_at IS NULL',
      [req.params.docId, req.params.id]
    );
  } else {
    query = await pool.query(
      `SELECT kd.s3_key_encrypted FROM kyc_documents kd
       JOIN importers i ON i.id = kd.importer_id
       WHERE kd.id = $1 AND kd.importer_id = $2 AND i.user_id = $3 AND kd.deleted_at IS NULL`,
      [req.params.docId, req.params.id, user.id]
    );
  }
  if (!query.rowCount) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const s3Key = s3KeyDecrypt(query.rows[0]!.s3_key_encrypted);
  const url = generatePresignedUrl(s3Key);
  res.json({ url, expiresInSeconds: 900 });
});
