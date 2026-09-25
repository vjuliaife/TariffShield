// #317 — Electronic Bond Signature via DocuSign (or HelloSign as alternative)
//
// DocuSign integration pattern:
//   1. POST /api/v1/bonds/:id/send-for-signature — create envelope, return envelope_id
//   2. GET  /api/v1/bonds/:id/signature-status   — poll envelope status
//   3. POST /api/v1/bonds/docusign-webhook        — receive completion events (HMAC-verified)
//
// All DocuSign API calls are stubbed; swap in the DocuSign Node SDK when
// DOCUSIGN_INTEGRATION_KEY is configured.

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

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
  _importerName: string,
  _suretyEmail: string
): Promise<{ envelopeId: string; signingUrl: string }> {
  if (env.DOCUSIGN_INTEGRATION_KEY) {
    // Production: POST /v2.1/accounts/{accountId}/envelopes via DocuSign SDK
    // const dsApiClient = new docusign.ApiClient();
    // dsApiClient.setBasePath(env.DOCUSIGN_BASE_PATH);
    // ... JWT grant, create envelope with Form 301 template, get embedded signing URL
    throw new Error('DocuSign SDK integration not yet wired — configure DOCUSIGN_* env vars');
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
  '/bonds/:id/send-for-signature',
  requireRole('surety_admin'),
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
      [bondRecordId]
    );
    if (!bondResult.rowCount) {
      res.status(404).json({ error: 'bond not found' });
      return;
    }
    const bond = bondResult.rows[0]!;

    if (bond.signature_status === 'completed') {
      res.status(409).json({ error: 'bond already has a completed signature' });
      return;
    }

    const suretyAdminResult = await pool.query(
      "SELECT email FROM users WHERE role = 'surety_admin' LIMIT 1"
    );
    const suretyEmail = suretyAdminResult.rows[0]?.email ?? 'surety@tariffshield.io';

    let envelope: { envelopeId: string; signingUrl: string };
    try {
      envelope = await createDocuSignEnvelope(
        bond.bond_id.toString(),
        bond.importer_email,
        bond.principal_legal_name,
        suretyEmail
      );
    } catch (err: any) {
      // #977: 5xx responses across the API return a fixed error string with
      // no upstream error detail — the underlying message is logged
      // server-side instead of echoed to the client, matching every other
      // 5xx handler (see health.ts, erasure.ts) and avoiding leaking
      // internal/DocuSign error text.
      logger.error({ err, bondId: bond.bond_id }, 'DocuSign envelope creation failed');
      res.status(502).json({ error: 'envelope creation failed' });
      return;
    }

    // Store envelope record
    const sig = await pool.query(
      `INSERT INTO bond_signatures (bond_record_id, envelope_id, signing_url, status)
       VALUES ($1, $2, $3, 'sent')
       ON CONFLICT (envelope_id) DO UPDATE
         SET signing_url = EXCLUDED.signing_url, updated_at = now()
       RETURNING id, envelope_id, signing_url, status, created_at`,
      [bondRecordId, envelope.envelopeId, envelope.signingUrl]
    );

    await pool.query("UPDATE bond_records SET signature_status = 'sent' WHERE id = $1", [
      bondRecordId,
    ]);

    res.status(201).json({ signature: sig.rows[0] });
  }
);

// GET /api/v1/bonds/:id/signature-status
bondSignaturesRouter.get('/bonds/:id/signature-status', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const bondRecordId = req.params.id!;

  // Scope: surety_admin sees any bond; importer sees only their own
  let bondQuery;
  if (user.role === 'surety_admin') {
    bondQuery = await pool.query(
      'SELECT br.id, br.signature_status FROM bond_records br WHERE br.id = $1',
      [bondRecordId]
    );
  } else {
    bondQuery = await pool.query(
      `SELECT br.id, br.signature_status FROM bond_records br
       JOIN importers i ON i.id = br.importer_id
       WHERE br.id = $1 AND i.user_id = $2`,
      [bondRecordId, user.id]
    );
  }
  if (!bondQuery.rowCount) {
    res.status(404).json({ error: 'bond not found' });
    return;
  }

  const sigResult = await pool.query(
    `SELECT id, envelope_id, signing_url, status, signed_document_hash,
            completed_at, last_reminder_sent_at, created_at
     FROM bond_signatures WHERE bond_record_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [bondRecordId]
  );

  res.json({
    bondId: bondRecordId,
    signatureStatus: bondQuery.rows[0]!.signature_status,
    envelope: sigResult.rows[0] ?? null,
  });
});

// POST /bonds/docusign-webhook — DocuSign Connect event receiver (no auth; HMAC-verified)
// Raw body parsing needed for HMAC verification — mount before express.json()
bondWebhookRouter.post('/bonds/docusign-webhook', async (req: Request, res: Response) => {
  // Verify HMAC-SHA256 signature from DocuSign Connect
  const receivedSig = req.headers['x-docusign-signature-1'] as string | undefined;
  if (env.DOCUSIGN_WEBHOOK_HMAC_KEY && receivedSig) {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (rawBody) {
      const expected = crypto
        .createHmac('sha256', env.DOCUSIGN_WEBHOOK_HMAC_KEY)
        .update(rawBody)
        .digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(receivedSig), Buffer.from(expected))) {
        res.status(401).json({ error: 'invalid webhook signature' });
        return;
      }
    }
  }

  const body = req.body as any;
  const envelopeId: string | undefined =
    body?.envelopeId ?? body?.data?.envelopeSummary?.envelopeId;
  const status: string | undefined = body?.status ?? body?.data?.envelopeSummary?.status;

  if (!envelopeId || !status) {
    res.status(400).json({ error: 'missing envelopeId or status' });
    return;
  }

  if (status === 'completed') {
    // Compute SHA-256 of the raw envelope for audit (#317)
    const rawBodyBuf = (req as any).rawBody as Buffer | undefined;
    const docHash = rawBodyBuf
      ? crypto.createHash('sha256').update(rawBodyBuf).digest('hex')
      : null;

    await pool.query(
      `UPDATE bond_signatures
         SET status = 'completed', signed_document_hash = $1,
             completed_at = now(), updated_at = now()
         WHERE envelope_id = $2`,
      [docHash, envelopeId]
    );

    // Update bond_records so the API can gate deposits
    await pool.query(
      `UPDATE bond_records SET signature_status = 'completed'
         WHERE id = (SELECT bond_record_id FROM bond_signatures WHERE envelope_id = $1)`,
      [envelopeId]
    );
  } else if (status === 'declined' || status === 'voided') {
    await pool.query(
      `UPDATE bond_signatures SET status = $1, updated_at = now() WHERE envelope_id = $2`,
      [status, envelopeId]
    );
  }

  res.status(200).json({ received: true });
});

  }
);

// #1022: GET /api/v1/bonds/:id/reminders — view reminder history for a bond (surety_admin)
bondSignaturesRouter.get(
  '/bonds/:id/reminders',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const bondRecordId = req.params.id!;
    const reminders = await pool.query(
      `SELECT r.id, r.envelope_id, r.reminder_number, r.recipient_email, r.sent_at, r.status
       FROM bond_signature_reminders r
       WHERE r.bond_record_id = $1
       ORDER BY r.sent_at DESC`,
      [bondRecordId]
    );
    res.json({ reminders: reminders.rows });
  }
);

// #1022: GET /api/v1/bonds/reminder-config — get configurable reminder cadence (surety_admin)
bondSignaturesRouter.get(
  '/bonds/reminder-config',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const config = await pool.query(
      'SELECT cadence_days, is_enabled FROM bond_signature_reminder_configs WHERE surety_id = $1',
      [user.id]
    );
    if (!config.rowCount) {
      res.json({ config: { cadenceDays: [2, 5, 7], isEnabled: true } });
      return;
    }
    res.json({
      config: {
        cadenceDays: config.rows[0].cadence_days,
        isEnabled: config.rows[0].is_enabled,
      },
    });
  }
);

// #1022: PUT /api/v1/bonds/reminder-config — update configurable reminder cadence (surety_admin)
bondSignaturesRouter.put(
  '/bonds/reminder-config',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const { cadenceDays, isEnabled } = req.body ?? {};
    if (!Array.isArray(cadenceDays) || cadenceDays.some((d: any) => typeof d !== 'number' || d <= 0)) {
      res.status(400).json({ error: 'invalid cadenceDays array' });
      return;
    }
    const upserted = await pool.query(
      `INSERT INTO bond_signature_reminder_configs (surety_id, cadence_days, is_enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (surety_id) DO UPDATE
         SET cadence_days = EXCLUDED.cadence_days,
             is_enabled = EXCLUDED.is_enabled,
             updated_at = NOW()
       RETURNING cadence_days, is_enabled`,
      [user.id, cadenceDays, isEnabled ?? true]
    );
    res.json({
      config: {
        cadenceDays: upserted.rows[0].cadence_days,
        isEnabled: upserted.rows[0].is_enabled,
      },
    });
  }
);

// #1022: Automated reminder sequence polling worker for outstanding signature requests
export async function processPendingSignatureReminders(): Promise<{ processedCount: number }> {
  const pending = await pool.query(
    `SELECT bs.id AS sig_id, bs.bond_record_id, bs.envelope_id, bs.created_at, bs.last_reminder_sent_at,
            br.importer_id, u.id AS importer_user_id, u.email AS importer_email
     FROM bond_signatures bs
     JOIN bond_records br ON br.id = bs.bond_record_id
     JOIN importers i ON i.id = br.importer_id
     JOIN users u ON u.id = i.user_id
     WHERE bs.status = 'sent' AND br.signature_status = 'sent'`
  );

  let processedCount = 0;
  for (const row of pending.rows) {
    const daysSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const sentCountRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM bond_signature_reminders WHERE bond_record_id = $1',
      [row.bond_record_id]
    );
    const sentCount = sentCountRes.rows[0]?.count ?? 0;
    const defaultCadence = [2, 5, 7];

    if (sentCount < defaultCadence.length) {
      const targetThresholdDays = defaultCadence[sentCount]!;
      if (daysSinceCreated >= targetThresholdDays) {
        const reminderNum = sentCount + 1;
        await pool.query(
          'INSERT INTO bond_signature_reminders (bond_record_id, envelope_id, reminder_number, recipient_email) VALUES ($1, $2, $3, $4)',
          [row.bond_record_id, row.envelope_id, reminderNum, row.importer_email]
        );
        await pool.query('UPDATE bond_signatures SET last_reminder_sent_at = NOW() WHERE id = $1', [row.sig_id]);

        await pool.query(
          `INSERT INTO notifications (user_id, kind, message) VALUES ($1, $2, $3)`,
          [
            row.importer_user_id,
            'BOND_SIGNATURE_REMINDER',
            `Reminder #${reminderNum}: You have an unsigned customs bond signature pending. Please review and sign your envelope.`,
          ]
        );
        processedCount++;
      }
    }
  }
  return { processedCount };
}

