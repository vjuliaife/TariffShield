// #317 — Electronic Bond Signature via DocuSign (or HelloSign as alternative)
//
// DocuSign integration pattern:
//   1. POST /api/v1/bonds/:id/send-for-signature — create envelope, return envelope_id
//   2. GET  /api/v1/bonds/:id/signature-status   — poll envelope status
//   3. POST /api/v1/bonds/docusign-webhook        — receive completion events (HMAC-verified)
//
// All DocuSign API calls are stubbed; swap in the DocuSign Node SDK when
// DOCUSIGN_INTEGRATION_KEY is configured.

import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { authMiddleware, requireRole, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";
import { env } from "../config/env.js";

// bondSignaturesRouter — authenticated routes (send-for-signature, status, reminder)
export const bondSignaturesRouter = Router();
bondSignaturesRouter.use(authMiddleware);
bondSignaturesRouter.use(privacyReacceptanceGate);
bondSignaturesRouter.use(tosReacceptanceGate);

// bondWebhookRouter — unauthenticated (DocuSign Connect); mounted separately in index.ts
export const bondWebhookRouter = Router();

// Stub: in production call DocuSign eSignature REST API to create an envelope.
async function createDocuSignEnvelope(
  bondId: string,
  importerEmail: string,
  importerName: string,
  suretyEmail: string,
): Promise<{ envelopeId: string; signingUrl: string }> {
  if (env.DOCUSIGN_INTEGRATION_KEY) {
    // Production: POST /v2.1/accounts/{accountId}/envelopes via DocuSign SDK
    // const dsApiClient = new docusign.ApiClient();
    // dsApiClient.setBasePath(env.DOCUSIGN_BASE_PATH);
    // ... JWT grant, create envelope with Form 301 template, get embedded signing URL
    throw new Error("DocuSign SDK integration not yet wired — configure DOCUSIGN_* env vars");
  }
  // Dev stub — deterministic for testing
  const envelopeId = `STUB-ENV-${bondId}-${Date.now()}`;
  return {
    envelopeId,
    signingUrl: `https://demo.docusign.net/signing?envelope=${envelopeId}&email=${encodeURIComponent(importerEmail)}`,
  };
}

// POST /api/v1/bonds/:id/send-for-signature
bondSignaturesRouter.post(
  "/bonds/:id/send-for-signature",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const bondRecordId = req.params.id!;

    // Load bond record and importer
    const bondResult = await pool.query(
      `SELECT br.id, br.importer_id, br.bond_id, br.principal_legal_name, br.signature_status,
              u.email AS importer_email
       FROM bond_records br
       JOIN importers i ON i.id = br.importer_id
       JOIN users u ON u.id = i.user_id
       WHERE br.id = $1`,
      [bondRecordId],
    );
    if (!bondResult.rowCount) {
      res.status(404).json({ error: "bond not found" });
      return;
    }
    const bond = bondResult.rows[0]!;

    if (bond.signature_status === "completed") {
      res.status(409).json({ error: "bond already has a completed signature" });
      return;
    }

    const suretyAdminResult = await pool.query(
      "SELECT email FROM users WHERE role = 'surety_admin' LIMIT 1",
    );
    const suretyEmail = suretyAdminResult.rows[0]?.email ?? "surety@tariffshield.io";

    let envelope: { envelopeId: string; signingUrl: string };
    try {
      envelope = await createDocuSignEnvelope(
        bond.bond_id.toString(),
        bond.importer_email,
        bond.principal_legal_name,
        suretyEmail,
      );
    } catch (err: any) {
      res.status(502).json({ error: "envelope creation failed", detail: err.message });
      return;
    }

    // Store envelope record
    const sig = await pool.query(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status)
       VALUES ($1, $2, $3, 'sent')
       ON CONFLICT (envelope_id) DO UPDATE
         SET signing_url = EXCLUDED.signing_url, updated_at = now()
       RETURNING id, envelope_id, signing_url, status, created_at`,
      [bondRecordId, envelope.envelopeId, envelope.signingUrl],
    );

    await pool.query(
      "UPDATE bond_records SET signature_status = 'sent' WHERE id = $1",
      [bondRecordId],
    );

    res.status(201).json({ signature: sig.rows[0] });
  },
);

// GET /api/v1/bonds/:id/signature-status
bondSignaturesRouter.get("/bonds/:id/signature-status", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const bondRecordId = req.params.id!;

  // Scope: surety_admin sees any bond; importer sees only their own
  let bondQuery;
  if (user.role === "surety_admin") {
    bondQuery = await pool.query(
      "SELECT br.id, br.signature_status FROM bond_records br WHERE br.id = $1",
      [bondRecordId],
    );
  } else {
    bondQuery = await pool.query(
      `SELECT br.id, br.signature_status FROM bond_records br
       JOIN importers i ON i.id = br.importer_id
       WHERE br.id = $1 AND i.user_id = $2`,
      [bondRecordId, user.id],
    );
  }
  if (!bondQuery.rowCount) {
    res.status(404).json({ error: "bond not found" });
    return;
  }

  const sigResult = await pool.query(
    `SELECT id, envelope_id, signing_url, status, signed_document_hash,
            completed_at, last_reminder_sent_at, created_at
     FROM bond_signatures WHERE bond_record_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [bondRecordId],
  );

  res.json({
    bondId: bondRecordId,
    signatureStatus: bondQuery.rows[0]!.signature_status,
    envelope: sigResult.rows[0] ?? null,
  });
});

// POST /bonds/docusign-webhook — DocuSign Connect event receiver (no auth; HMAC-verified)
// Raw body parsing needed for HMAC verification — mount before express.json()
bondWebhookRouter.post(
  "/bonds/docusign-webhook",
  async (req: Request, res: Response) => {
    // Verify HMAC-SHA256 signature from DocuSign Connect
    const receivedSig = req.headers["x-docusign-signature-1"] as string | undefined;
    if (env.DOCUSIGN_WEBHOOK_HMAC_KEY && receivedSig) {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (rawBody) {
        const expected = crypto
          .createHmac("sha256", env.DOCUSIGN_WEBHOOK_HMAC_KEY)
          .update(rawBody)
          .digest("base64");
        if (!crypto.timingSafeEqual(Buffer.from(receivedSig), Buffer.from(expected))) {
          res.status(401).json({ error: "invalid webhook signature" });
          return;
        }
      }
    }

    const body = req.body as any;
    const envelopeId: string | undefined = body?.envelopeId ?? body?.data?.envelopeSummary?.envelopeId;
    const status: string | undefined = body?.status ?? body?.data?.envelopeSummary?.status;

    if (!envelopeId || !status) {
      res.status(400).json({ error: "missing envelopeId or status" });
      return;
    }

    if (status === "completed") {
      // Compute SHA-256 of the raw envelope for audit (#317)
      const rawBodyBuf = (req as any).rawBody as Buffer | undefined;
      const docHash = rawBodyBuf
        ? crypto.createHash("sha256").update(rawBodyBuf).digest("hex")
        : null;

      await pool.query(
        `UPDATE bond_signatures
         SET status = 'completed', signed_document_hash = $1,
             completed_at = now(), updated_at = now()
         WHERE envelope_id = $2`,
        [docHash, envelopeId],
      );

      // Update bond_records so the API can gate deposits
      await pool.query(
        `UPDATE bond_records SET signature_status = 'completed'
         WHERE id = (SELECT bond_record_id FROM bond_signatures WHERE envelope_id = $1)`,
        [envelopeId],
      );
    } else if (status === "declined" || status === "voided") {
      await pool.query(
        `UPDATE bond_signatures SET status = $1, updated_at = now() WHERE envelope_id = $2`,
        [status, envelopeId],
      );
    }

    res.status(200).json({ received: true });
  },
);

// POST /api/v1/bonds/:id/send-reminder — email reminder for unsigned envelope
bondSignaturesRouter.post(
  "/bonds/:id/send-reminder",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const bondRecordId = req.params.id!;
    const sig = await pool.query(
      `SELECT id, envelope_id, status, created_at, last_reminder_sent_at
       FROM bond_signatures WHERE bond_record_id = $1 AND status = 'sent'
       ORDER BY created_at DESC LIMIT 1`,
      [bondRecordId],
    );
    if (!sig.rowCount) {
      res.status(404).json({ error: "no pending envelope found for this bond" });
      return;
    }

    const envelope = sig.rows[0]!;
    const hoursSinceCreated = (Date.now() - new Date(envelope.created_at).getTime()) / 3_600_000;
    if (hoursSinceCreated < 72) {
      // Send reminder stub — in production call DocuSign resend API
      await pool.query(
        "UPDATE bond_signatures SET last_reminder_sent_at = now() WHERE id = $1",
        [envelope.id],
      );
      res.json({ reminded: true, envelopeId: envelope.envelope_id });
    } else {
      res.status(410).json({ error: "72-hour signing deadline has passed; void and reissue" });
    }
  },
);
