import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, requireRole, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";
import { encryptFieldToJson, decryptFieldFromJson } from "../lib/field-encryption.js";
import { env } from "../config/env.js";

export const kycRouter = Router();
kycRouter.use(authMiddleware);
kycRouter.use(privacyReacceptanceGate);
kycRouter.use(tosReacceptanceGate);

// BSA requires 5-year retention from last transaction; we track scheduled_deletion_date.
// In production, S3 keys are stored encrypted; actual documents never touch the DB.

const BSA_RETENTION_DAYS = 5 * 365;

function s3KeyEncrypt(key: string): string {
  return encryptFieldToJson(key) ?? key;
}

function s3KeyDecrypt(encrypted: string): string {
  try {
    return decryptFieldFromJson(encrypted) ?? encrypted;
  } catch {
    return "[decryption error]";
  }
}

// Stub: in production, use AWS SDK PutObjectCommand to S3_KYC_BUCKET with SSE-KMS.
// Returns the S3 object key for the uploaded document.
async function uploadDocumentToS3(
  importerId: string,
  documentType: string,
  fileBuffer: Buffer,
  mimeType: string,
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
function generatePresignedUrl(s3Key: string): string {
  if (env.S3_KYC_BUCKET) {
    return `https://${env.S3_KYC_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${s3Key}?presigned=stub`;
  }
  return `/dev/kyc-stub/${s3Key}`;
}

const UploadKycSchema = z.object({
  documentType: z.enum(["articles_of_incorporation", "ein_confirmation", "beneficial_ownership_fincen_102"]),
  // In production, file bytes come from multipart/form-data (multer/busboy).
  // For now, accept a base64-encoded payload for API simplicity.
  fileBase64: z.string().min(1),
  mimeType: z.string().regex(/^(application\/pdf|image\/(png|jpeg))$/),
});

// POST /api/v1/importers/:id/kyc — upload a KYC document (importer only)
kycRouter.post("/:id/kyc", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "importer") {
    res.status(403).json({ error: "only importers can upload KYC documents" });
    return;
  }

  const imp = await pool.query(
    "SELECT id FROM importers WHERE id = $1 AND user_id = $2",
    [req.params.id, user.id],
  );
  if (!imp.rowCount) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const importerId: string = imp.rows[0]!.id;

  const parse = UploadKycSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { documentType, fileBase64, mimeType } = parse.data;
  const fileBuffer = Buffer.from(fileBase64, "base64");

  const s3Key = await uploadDocumentToS3(importerId, documentType, fileBuffer, mimeType);
  const encryptedKey = s3KeyEncrypt(s3Key);

  // BSA minimum 5-year retention from upload; updated when importer has a transaction.
  const scheduledDeletion = new Date(Date.now() + BSA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO kyc_documents (importer_id, document_type, s3_key_encrypted, scheduled_deletion_date)
     VALUES ($1, $2, $3, $4)
     RETURNING id, document_type, upload_timestamp, review_status, scheduled_deletion_date`,
    [importerId, documentType, encryptedKey, scheduledDeletion],
  );

  res.status(201).json({ document: result.rows[0] });
});

// GET /api/v1/importers/:id/kyc — list KYC documents for an importer
kycRouter.get("/:id/kyc", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  let importerCheck;
  if (user.role === "surety_admin") {
    importerCheck = await pool.query("SELECT id FROM importers WHERE id = $1", [req.params.id]);
  } else {
    importerCheck = await pool.query(
      "SELECT id FROM importers WHERE id = $1 AND user_id = $2",
      [req.params.id, user.id],
    );
  }
  if (!importerCheck.rowCount) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const docs = await pool.query(
    `SELECT id, document_type, upload_timestamp, review_status, reviewed_at, reviewer_note,
            scheduled_deletion_date, deleted_at
     FROM kyc_documents WHERE importer_id = $1 AND deleted_at IS NULL
     ORDER BY upload_timestamp DESC`,
    [req.params.id],
  );
  res.json({ documents: docs.rows });
});

// POST /api/v1/importers/:id/kyc/:docId/review — surety_admin approves/rejects a document
kycRouter.post(
  "/:id/kyc/:docId/review",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;

    const parse = z.object({
      decision: z.enum(["approved", "rejected"]),
      note: z.string().min(1),
    }).safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "decision and note are required" });
      return;
    }
    const { decision, note } = parse.data;

    const doc = await pool.query(
      `SELECT kd.id, kd.importer_id FROM kyc_documents kd
       JOIN importers i ON i.id = kd.importer_id
       WHERE kd.id = $1 AND kd.importer_id = $2 AND kd.deleted_at IS NULL`,
      [req.params.docId, req.params.id],
    );
    if (!doc.rowCount) {
      res.status(404).json({ error: "document not found" });
      return;
    }

    await pool.query(
      `UPDATE kyc_documents
       SET review_status = $1, reviewer_id = $2, reviewer_note = $3, reviewed_at = now()
       WHERE id = $4`,
      [decision, user.id, note, req.params.docId],
    );

    // Update importer KYC status when a document is approved/rejected.
    // Approved only when at least one document is approved and none are rejected.
    const statusResult = await pool.query(
      `SELECT
         BOOL_OR(review_status = 'approved') AS has_approved,
         BOOL_OR(review_status = 'rejected') AS has_rejected
       FROM kyc_documents WHERE importer_id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    const { has_approved, has_rejected } = statusResult.rows[0] ?? {};
    const kycStatus = has_rejected ? "rejected" : has_approved ? "approved" : "pending";
    await pool.query("UPDATE importers SET kyc_status = $1 WHERE id = $2", [kycStatus, req.params.id]);

    res.json({ success: true, importerKycStatus: kycStatus });
  },
);

// GET /api/v1/importers/:id/kyc/:docId/download — get a pre-signed S3 URL (surety_admin or owner)
kycRouter.get("/:id/kyc/:docId/download", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  let query;
  if (user.role === "surety_admin") {
    query = await pool.query(
      "SELECT kd.s3_key_encrypted FROM kyc_documents kd WHERE kd.id = $1 AND kd.importer_id = $2 AND kd.deleted_at IS NULL",
      [req.params.docId, req.params.id],
    );
  } else {
    query = await pool.query(
      `SELECT kd.s3_key_encrypted FROM kyc_documents kd
       JOIN importers i ON i.id = kd.importer_id
       WHERE kd.id = $1 AND kd.importer_id = $2 AND i.user_id = $3 AND kd.deleted_at IS NULL`,
      [req.params.docId, req.params.id, user.id],
    );
  }
  if (!query.rowCount) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const s3Key = s3KeyDecrypt(query.rows[0]!.s3_key_encrypted);
  const url = generatePresignedUrl(s3Key);
  res.json({ url, expiresInSeconds: 900 });
});
