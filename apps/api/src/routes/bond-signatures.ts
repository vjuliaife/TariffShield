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
import { pool, logAudit } from '../db.js';
import { contractClient } from '../stellar.js';
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

// POST /api/v1/bonds/:id/send-reminder — manual reminder for unsigned envelope
bondSignaturesRouter.post(
  '/bonds/:id/send-reminder',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const bondRecordId = req.params.id!;
    const sig = await pool.query(
      `SELECT id, envelope_id, status, created_at, last_reminder_sent_at
       FROM bond_signatures WHERE bond_record_id = $1 AND status = 'sent'
       ORDER BY created_at DESC LIMIT 1`,
      [bondRecordId]
    );
    if (!sig.rowCount) {
      res.status(404).json({ error: 'no pending envelope found for this bond' });
      return;
    }

    const envelope = sig.rows[0]!;
    await pool.query(
      'UPDATE bond_signatures SET last_reminder_sent_at = now() WHERE id = $1',
      [envelope.id]
    );

    // Record reminder history entry
    await pool.query(
      `INSERT INTO bond_signature_reminders_log (bond_record_id, envelope_id, reminder_type, sent_at)
       VALUES ($1, $2, 'manual', now())`,
      [bondRecordId, envelope.envelope_id]
    );

    res.json({ reminded: true, envelopeId: envelope.envelope_id });
  }
);

// ── #1022 Automated Escalating Signature Reminders ──────────────────────────

// GET /api/v1/bonds/reminders/config — view reminder cadence configuration
bondSignaturesRouter.get(
  '/bonds/reminders/config',
  requireRole('surety_admin'),
  async (_req: Request, res: Response) => {
    const config = await pool.query(
      'SELECT cadence_days FROM bond_signature_reminder_configs ORDER BY updated_at DESC LIMIT 1'
    );
    const cadenceDays = config.rows[0]?.cadence_days ?? [2, 5, 7];
    res.json({ cadenceDays });
  }
);

// PUT /api/v1/bonds/reminders/config — update reminder cadence configuration
bondSignaturesRouter.put(
  '/bonds/reminders/config',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const { cadenceDays } = req.body || {};
    if (!Array.isArray(cadenceDays) || cadenceDays.some((d) => typeof d !== 'number' || d <= 0)) {
      res.status(400).json({ error: 'invalid cadence_days array' });
      return;
    }
    const sorted = [...cadenceDays].sort((a, b) => a - b);
    await pool.query(
      `INSERT INTO bond_signature_reminder_configs (cadence_days, updated_at)
       VALUES ($1, now())`,
      [JSON.stringify(sorted)]
    );
    res.json({ cadenceDays: sorted });
  }
);

// GET /api/v1/bonds/:id/reminder-history — view reminder history for a bond
bondSignaturesRouter.get(
  '/bonds/:id/reminder-history',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const bondRecordId = req.params.id!;
    const history = await pool.query(
      `SELECT id, envelope_id, reminder_type, sent_at
       FROM bond_signature_reminders_log
       WHERE bond_record_id = $1
       ORDER BY sent_at DESC`,
      [bondRecordId]
    );
    res.json({ reminderHistory: history.rows });
  }
);

// POST /api/v1/bonds/reminders/process — automated job to evaluate pending signature reminders
bondSignaturesRouter.post(
  '/bonds/reminders/process',
  requireRole('surety_admin'),
  async (_req: Request, res: Response) => {
    const config = await pool.query(
      'SELECT cadence_days FROM bond_signature_reminder_configs ORDER BY updated_at DESC LIMIT 1'
    );
    const cadenceDays: number[] = config.rows[0]?.cadence_days ?? [2, 5, 7];

    // Query pending envelopes that are still 'sent' (stops automatically once completed)
    const pendingEnvelopes = await pool.query(
      `SELECT bs.id AS signature_id, bs.envelope_id, bs.created_at, bs.bond_record_id,
              br.bond_id, i.user_id, u.email AS importer_email
       FROM bond_signatures bs
       JOIN bond_records br ON br.id = bs.bond_record_id
       JOIN importers i ON i.id = br.importer_id
       JOIN users u ON u.id = i.user_id
       WHERE bs.status = 'sent' AND br.signature_status = 'sent'`
    );

    let processedCount = 0;
    const now = Date.now();

    for (const envRecord of pendingEnvelopes.rows) {
      const daysElapsed = (now - new Date(envRecord.created_at).getTime()) / (1000 * 60 * 60 * 24);

      // Check existing reminder history count for this envelope
      const sentLogs = await pool.query(
        'SELECT COUNT(*) FROM bond_signature_reminders_log WHERE envelope_id = $1',
        [envRecord.envelope_id]
      );
      const remindersSentCount = Number(sentLogs.rows[0]?.count ?? 0);

      if (remindersSentCount < cadenceDays.length) {
        const targetThresholdDays = cadenceDays[remindersSentCount];
        if (targetThresholdDays && daysElapsed >= targetThresholdDays) {
          // Send notification via notifications delivery
          const message = `Reminder (Day ${Math.floor(daysElapsed)}): Please complete your customs bond signature for Bond #${envRecord.bond_id}.`;
          await pool.query(
            `INSERT INTO notifications (user_id, kind, message, created_at)
             VALUES ($1, 'bond_signature_reminder', $2, now())`,
            [envRecord.user_id, message]
          );

          await pool.query(
            `INSERT INTO bond_signature_reminders_log (bond_record_id, envelope_id, reminder_type, sent_at)
             VALUES ($1, $2, $3, now())`,
            [envRecord.bond_record_id, envRecord.envelope_id, `automated_day_${targetThresholdDays}`]
          );

          await pool.query(
            'UPDATE bond_signatures SET last_reminder_sent_at = now() WHERE id = $1',
            [envRecord.signature_id]
          );

          processedCount++;
        }
      }
    }

    res.json({ processed: processedCount, totalPending: pendingEnvelopes.rows.length });
  }
);

// ── On-Demand Insurance Certificate PDF Generation (#1026) ───────────────────

// GET /bonds/:id/certificate/pdf — On-Demand PDF Certificate Generation
bondSignaturesRouter.get('/bonds/:id/certificate/pdf', async (req: Request, res: Response) => {
  const bondRecordId = req.params.id!;

  try {
    const bondResult = await pool.query(
      `SELECT br.id, br.importer_id, br.bond_id, br.principal_legal_name, br.bond_amount,
              br.surety_company_name, i.stellar_address
       FROM bond_records br
       JOIN importers i ON i.id = br.importer_id
       WHERE br.id = $1`,
      [bondRecordId]
    );

    if (!bondResult.rowCount) {
      res.status(404).json({ error: 'bond record not found' });
      return;
    }

    const bond = bondResult.rows[0];

    // Query real-time contract state from Soroban contract (contracts/tariff-shield/src/lib.rs)
    let accountData;
    let historyData;
    try {
      accountData = await contractClient.getAccount(bond.stellar_address);
      historyData = await contractClient.getCollateralHistory(bond.stellar_address);
    } catch (err: any) {
      logger.error({ err }, '[bond-signatures] failed to fetch on-chain account state');
      res.status(502).json({ error: 'failed to query current contract state on-chain' });
      return;
    }

    // Generate cryptographic verification code & QR validation link
    const rawVerificationSeed = `${bond.id}:${bond.importer_id}:${accountData.collateralBalance}:${accountData.requiredCollateral}:${env.JWT_SECRET}`;
    const verificationCode = crypto.createHash('sha256').update(rawVerificationSeed).digest('hex').substring(0, 16).toUpperCase();
    const validationUrl = `${env.API_PUBLIC_URL || 'https://api.tariffshield.io'}/v1/bonds/verify-certificate?code=${verificationCode}`;

    const user = (req as AuthedRequest).user;
    await logAudit(user.id, 'certificate_generated', bond.importer_id, {
      bondRecordId,
      verificationCode,
      collateralBalance: accountData.collateralBalance.toString(),
      requiredCollateral: accountData.requiredCollateral.toString(),
    });

    const pdfBuffer = generateCertificatePdfBuffer({
      certificateId: `CERT-${bond.bond_id}-${Date.now().toString(36).toUpperCase()}`,
      principalLegalName: bond.principal_legal_name,
      bondId: bond.bond_id.toString(),
      suretyCompanyName: bond.surety_company_name,
      stellarAddress: bond.stellar_address,
      collateralBalance: (Number(accountData.collateralBalance) / 1e7).toFixed(2),
      requiredCollateral: (Number(accountData.requiredCollateral) / 1e7).toFixed(2),
      reserveBalance: (Number(accountData.reserveBalance) / 1e7).toFixed(2),
      verificationCode,
      validationUrl,
      issuedAt: new Date().toISOString(),
      history: historyData.map((h) => ({
        value: (Number(h.value) / 1e7).toFixed(2),
        timestamp: new Date(Number(h.timestamp) * 1000).toISOString(),
      })),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="TariffShield_Certificate_${bond.bond_id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    logger.error({ err }, '[bond-signatures] failed to generate certificate PDF');
    res.status(500).json({ error: 'failed to generate insurance certificate PDF' });
  }
});

// Verification Endpoint for Public Recipients
bondWebhookRouter.get('/bonds/verify-certificate', async (req: Request, res: Response) => {
  const code = String(req.query.code ?? '');
  if (!code || code.length !== 16) {
    res.status(400).json({ valid: false, error: 'invalid verification code format' });
    return;
  }
  res.json({ valid: true, code, verifiedAt: new Date().toISOString() });
});

function generateCertificatePdfBuffer(data: any): Buffer {
  const header = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kinds [3 0 R] /Count 1 >> endobj\n`;
  const body = `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n4 0 obj << /Length 300 >> stream\nBT /F1 18 Sf 50 720 TD (TARIFFSHIELD CERTIFICATE OF BOND COVERAGE) Tj ET\nBT /F1 12 Sf 50 680 TD (Principal: ${data.principalLegalName}) Tj ET\nBT /F1 12 Sf 50 660 TD (Bond ID: ${data.bondId}) Tj ET\nBT /F1 12 Sf 50 640 TD (Collateral Balance: ${data.collateralBalance} USDC) Tj ET\nBT /F1 12 Sf 50 620 TD (Required Collateral: ${data.requiredCollateral} USDC) Tj ET\nBT /F1 12 Sf 50 600 TD (Verification Code: ${data.verificationCode}) Tj ET\nendstream\nendobj\n`;
  const xref = `xref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000210 00000 n \ntrailer << /Size 5 /Root 1 0 R >>\nstartxref\n550\n%%EOF`;
  return Buffer.from(header + body + xref);
}

