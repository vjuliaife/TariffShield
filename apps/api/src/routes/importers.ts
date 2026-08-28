import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';
import {
  pool,
  getImporterMetrics,
  logAudit,
  refreshImporterMetricsView,
  getImporterReview,
} from '../db.js';
import { adminRouter } from './admin.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { requireLicenseVerified } from './surety-license.js';
import {
  contractClient,
  explorerTx,
  platformKeypair,
  getRequiredCollateralOnChain,
} from '../stellar.js';
import { lookupCbpDutyRate } from '../services/cbp-duty-lookup.js';
import { validateHtsRates } from '../services/hts-rate-validator.js';
import { screenImporterEntity, screenWalletAddress } from '../services/aml-screening.js';
import { validateBondForm301 } from '../services/cbp-bond-validation.js';
import { env } from '../config/env.js';
import { enqueueTxSubmit, txSubmitQueue } from '../queue.js';
import {
  getCachedOnChainAccount,
  setCachedOnChainAccount,
  invalidateOnChainAccount,
  type OnChainAccountView,
} from '../cache.js';

export const importersRouter = Router();
importersRouter.use(authMiddleware);
importersRouter.use(privacyReacceptanceGate);
importersRouter.use(tosReacceptanceGate);

const CreateImporterSchema = z.object({
  legalName: z.string().min(1),
  ein: z.string().optional(),
  bondId: z.coerce.number().int().positive(),
  initialRequiredCollateral: z.string().regex(/^\d+$/),
  businessState: z.string().length(2).toUpperCase().optional(),
});

importersRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'importer') {
    res.status(403).json({ error: 'only importer accounts can register' });
    return;
  }

  const parse = CreateImporterSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }
  const { legalName, ein, bondId, initialRequiredCollateral, businessState } = parse.data;

  const ofacClear = await screenImporterEntity(legalName, ein);
  if (!ofacClear) {
    res.status(403).json({ error: 'Importer failed OFAC sanctions screening' });
    return;
  }

  const existing = await pool.query('SELECT id FROM importers WHERE user_id = $1', [user.id]);
  if (existing.rowCount && existing.rowCount > 0) {
    res.status(409).json({ error: 'importer already registered for this user' });
    return;
  }

  const kp = Keypair.random();

  const amlRes = await screenWalletAddress(kp.publicKey());
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Wallet address flagged as high risk by AML provider' });
    return;
  }

  const bondValidation = validateBondForm301({
    principalLegalName: legalName,
    principalEin: ein,
    bondTypeCode: '02',
    bondAmount: BigInt(initialRequiredCollateral),
  });

  if (!bondValidation.valid) {
    res.status(422).json({
      error: 'Bond validation failed',
      details: bondValidation.errors,
    });
    return;
  }

  // #243: store a SHA-256 hash alongside the plaintext ein so future
  // lookups (dedup checks, lookup-by-ein) never need the raw value.
  const einHash = ein ? createHash('sha256').update(ein).digest('hex') : null;

  const inserted = await pool.query(
    `INSERT INTO importers (user_id, legal_name, ein, ein_hash, bond_id, stellar_address, stellar_secret_encrypted, business_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, legal_name, ein, bond_id, stellar_address, created_at`,
    [
      user.id,
      legalName,
      ein ?? null,
      einHash,
      bondId,
      kp.publicKey(),
      kp.secret(),
      businessState ?? 'CA',
    ]
  );
  const importer = inserted.rows[0]!;

  await pool.query(
    `INSERT INTO bond_records (importer_id, bond_id, bond_type_code, principal_legal_name, principal_ein,
                               surety_company_name, surety_fein, bond_amount, cbp_minimum_required, effective_date, template_version, cbp_regulation_revision_date, state_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      importer.id,
      bondId,
      '02',
      legalName,
      ein ?? null,
      'TBD',
      'TBD',
      initialRequiredCollateral,
      bondValidation.minimumRequired.toString(),
      new Date(),
      '1.0',
      new Date(),
      businessState ?? 'CA',
    ]
  );

  // Fund the importer account via friendbot (testnet only)
  try {
    const friendbotRes = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    if (!friendbotRes.ok) throw new Error(`friendbot ${friendbotRes.status}`);
  } catch (err) {
    req.log.error({ err }, 'friendbot fund failed');
  }

  // Register importer on-chain. Platform admin signs.
  const onChain = await contractClient.registerImporter(
    platformKeypair,
    kp.publicKey(),
    BigInt(bondId),
    BigInt(initialRequiredCollateral)
  );

  await pool.query('UPDATE importers SET registered_on_chain_tx = $1 WHERE id = $2', [
    onChain.txHash,
    importer.id,
  ]);
  // #228: bare ON CONFLICT DO NOTHING — required now that contract_events is
  // partitioned; see lib/contract-events-partitions.ts.
  await pool.query(
    `INSERT INTO contract_events (importer_id, kind, tx_hash, ledger_sequence, event_index)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [importer.id, 'register', onChain.txHash, onChain.ledgerSequence, onChain.applicationOrder]
  );

  await logAudit(user.id, 'register', importer.id, { legalName, bondId });

  res.json({
    importer: {
      id: importer.id,
      legalName: importer.legal_name,
      ein: importer.ein,
      bondId: importer.bond_id,
      stellarAddress: importer.stellar_address,
      stellarSecret: kp.secret(),
      registeredOnChainTx: onChain.txHash,
      stellarTxUrl: explorerTx(onChain.txHash),
      createdAt: importer.created_at,
    },
  });
});

importersRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  let r;
  if (user.role === 'surety_admin') {
    r = await pool.query(
      `SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at, u.email
         FROM importers i JOIN users u ON u.id = i.user_id
         ORDER BY i.created_at DESC`
    );
  } else {
    r = await pool.query(
      `SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at
         FROM importers i WHERE i.user_id = $1`,
      [user.id]
    );
  }
  res.json({ importers: r.rows });
});

// #251: surety-dashboard aggregate statistics, served from importer_metrics_mv
// (a materialized view refreshed on a 5-minute schedule — see
// jobs/refresh-importer-metrics.ts) instead of live GROUP BY queries.
// Registered before "/:id" so Express doesn't treat "stats" as an :id param.
importersRouter.get('/stats', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }
  const metrics = await getImporterMetrics();
  res.json({ metrics });
});

const AdminEventsQuerySchema = z.object({
  from: z.string().datetime({ message: "Invalid 'from' timestamp, must be ISO 8601" }).optional(),
  to: z.string().datetime({ message: "Invalid 'to' timestamp, must be ISO 8601" }).optional(),
  limit: z.coerce.number().int().positive().max(500).default(500),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// #245: Admin events endpoint for time-range reporting.
// Fetches contract events within a specified range, optimized via the BRIN index.
importersRouter.get('/admin/events', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  const parse = AdminEventsQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid query parameters', details: parse.error.issues });
    return;
  }

  const { limit, offset, from, to } = parse.data;

  const queryParams: any[] = [];
  let sql = `
    SELECT id, importer_id, kind, amount, tx_hash, created_at, ledger_sequence, event_index
    FROM contract_events
  `;
  const conditions: string[] = [];

  if (from) {
    queryParams.push(from);
    conditions.push(`created_at >= $${queryParams.length}`);
  }
  if (to) {
    queryParams.push(to);
    conditions.push(`created_at <= $${queryParams.length}`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC, id DESC';

  queryParams.push(limit);
  sql += ` LIMIT $${queryParams.length}`;

  queryParams.push(offset);
  sql += ` OFFSET $${queryParams.length}`;

  try {
    const result = await pool.query(sql, queryParams);
    const events = result.rows.map((row) => ({
      id: row.id,
      importerId: row.importer_id,
      kind: row.kind,
      amount: row.amount,
      txHash: row.tx_hash,
      txUrl: row.tx_hash ? explorerTx(row.tx_hash) : null,
      createdAt: row.created_at,
      ledgerSequence: row.ledger_sequence,
      eventIndex: row.event_index,
    }));
    res.json({ events });
  } catch (err: any) {
    console.error('[importers] Failed to query admin events:', err);
    res.status(500).json({ error: 'failed to retrieve events' });
  }
});

// #244: single-query admin review — importer profile + all attached
// kyc_documents rows, via importer_documents_view. Mounted under this
// router's existing /importers prefix as /importers/admin/:id/review,
// matching the /importers/admin/events convention just above (the issue's
// literal "/admin/importers/:id/review" path doesn't compose with that
// prefix). Registered before "/:id" for the same reason as /admin/events —
// Express would otherwise try to match "admin" as an :id param.
importersRouter.get('/admin/:id/review', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  const importerId = String(req.params.id ?? '');
  if (!z.string().uuid().safeParse(importerId).success) {
    res.status(400).json({ error: 'invalid importer id' });
    return;
  }

  try {
    const review = await getImporterReview(importerId);
    if (!review) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ review });
  } catch (err: any) {
    console.error('[importers] Failed to query importer review:', err);
    res.status(500).json({ error: 'failed to retrieve importer review' });
  }
});

async function loadImporterFor(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  if (user.role === 'surety_admin') {
    const r = await pool.query('SELECT * FROM importers WHERE id = $1', [importerId]);
    return r.rows[0] ?? null;
  }
  const r = await pool.query('SELECT * FROM importers WHERE id = $1 AND user_id = $2', [
    importerId,
    user.id,
  ]);
  return r.rows[0] ?? null;
}

/**
 * GET /admin/importers/metrics
 *
 * Returns all rows from the importer_metrics materialized view.
 * surety_admin only.
 */
adminRouter.get('/importers/metrics', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  try {
    const result = await pool.query('SELECT * FROM importer_metrics ORDER BY legal_name ASC');
    res.json({ metrics: result.rows });
  } catch (err) {
    console.error('[metrics] failed to get admin metrics:', err);
    res.status(500).json({ error: 'failed to retrieve importer metrics' });
  }
});

/**
 * GET /importers/:id/metrics
 *
 * Returns the single metrics row for the authenticated importer.
 */
importersRouter.get('/:id/metrics', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  try {
    const result = await pool.query('SELECT * FROM importer_metrics WHERE importer_id = $1', [
      importer.id,
    ]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'metrics not found for importer' });
      return;
    }
    res.json({ metrics: result.rows[0] });
  } catch (err) {
    console.error('[metrics] failed to get importer metrics:', err);
    res.status(500).json({ error: 'failed to retrieve importer metrics' });
  }
});

importersRouter.get('/:id', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // #246 — cache-aside: serve on-chain state from Redis when fresh (<=30s
  // old), otherwise fall back to the live Soroban RPC read and repopulate.
  let onChainAccount = await getCachedOnChainAccount(importer.id);
  if (!onChainAccount) {
    const acct = await contractClient.getAccount(importer.stellar_address);
    onChainAccount = {
      bondId: acct.bondId.toString(),
      collateralBalance: acct.collateralBalance.toString(),
      requiredCollateral: acct.requiredCollateral.toString(),
      reserveBalance: acct.reserveBalance.toString(),
      yieldAccrued: acct.yieldAccrued.toString(),
      isClawbacked: acct.isClawbacked,
    } satisfies OnChainAccountView;
    await setCachedOnChainAccount(importer.id, onChainAccount);
  }

  res.json({
    importer: {
      id: importer.id,
      legalName: importer.legal_name,
      ein: importer.ein,
      bondId: importer.bond_id,
      stellarAddress: importer.stellar_address,
      registeredOnChainTx: importer.registered_on_chain_tx,
      kycStatus: importer.kyc_status,
      createdAt: importer.created_at,
    },
    onChainAccount,
  });
});
// #248: cursor-paginated event log using efficient index seek.
// GET /importers/:id/events accepts ?cursor=&limit= query params (max limit 50, default 20).
// Seek uses WHERE id < :cursor ORDER BY id DESC LIMIT :limit.
const EventsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

importersRouter.get('/:id/events', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = EventsQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid query', details: parse.error.issues });
    return;
  }
  const { limit, cursor } = parse.data;

  const rows = cursor
    ? await pool.query(
        `SELECT id, kind, amount, tx_hash, created_at FROM contract_events
         WHERE importer_id = $1 AND id < $2
         ORDER BY id DESC LIMIT $3`,
        [importer.id, cursor, limit]
      )
    : await pool.query(
        `SELECT id, kind, amount, tx_hash, created_at FROM contract_events
         WHERE importer_id = $1
         ORDER BY id DESC LIMIT $2`,
        [importer.id, limit]
      );

  const events = rows.rows.map((e) => ({
    id: e.id,
    kind: e.kind,
    amount: e.amount,
    txHash: e.tx_hash,
    txUrl: e.tx_hash ? explorerTx(e.tx_hash) : null,
    createdAt: e.created_at,
  }));

  const last = rows.rows[rows.rows.length - 1];
  const nextCursor = rows.rows.length === limit && last ? last.id : null;

  res.json({ data: events, nextCursor });
});

importersRouter.get('/:id/collateral-status', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const acct = await contractClient.getAccount(importer.stellar_address);
  const lastUpdatedSeconds = Number(acct.collateralLastUpdated);
  const expiresAtSeconds = lastUpdatedSeconds + 365 * 86400;
  const stale = Math.floor(Date.now() / 1000) > expiresAtSeconds;
  res.json({
    stale,
    lastUpdated: new Date(lastUpdatedSeconds * 1000).toISOString(),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  });
});

// --- Synthetic CBP tariff CSV upload — recomputes required_collateral on-chain ---

const TariffLineItemSchema = z.object({
  htsCode: z.string(),
  value: z.coerce.number().positive(),
  dutyRate: z.coerce.number().min(0),
});

const TariffUploadSchema = z.object({
  filename: z.string().optional(),
  lineItems: z.array(TariffLineItemSchema),
});

// ── #233: tariff-spike alert evaluation, run after every tariff CSV upload ──
//
// "Active" == not yet triggered (triggered_at IS NULL); this is the
// deduplication mechanism the issue describes — an alert fires once per
// spike and then stays out of future evaluations, rather than re-notifying
// on every subsequent upload that still breaches the same threshold. There's
// no resolve/reset endpoint in this issue's scope, so a triggered alert stays
// triggered until #230's notification/resolution flow (whatever it turns out
// to be) adds one.
//
// `threshold_type = 'absolute'` compares the new upload's annual_duty_total
// directly against the configured threshold. `'percent_increase'` compares
// the percentage change against the importer's immediately preceding upload
// (per the AC) — skipped entirely if there is no preceding upload, or if it
// was exactly 0 (an increase off a zero baseline isn't a meaningful
// percentage and would divide by zero).
async function evaluateTariffAlerts(
  importerId: string,
  newAnnualDutyTotal: number,
  previousAnnualDutyTotal: number | null
): Promise<void> {
  const active = await pool.query(
    'SELECT id, threshold, threshold_type FROM alerts WHERE importer_id = $1 AND triggered_at IS NULL',
    [importerId]
  );

  for (const alert of active.rows) {
    const threshold = Number(alert.threshold);
    let triggerValue: number | null = null;

    if (alert.threshold_type === 'absolute') {
      if (newAnnualDutyTotal >= threshold) {
        triggerValue = newAnnualDutyTotal;
      }
    } else if (previousAnnualDutyTotal !== null && previousAnnualDutyTotal > 0) {
      const pctIncrease =
        ((newAnnualDutyTotal - previousAnnualDutyTotal) / previousAnnualDutyTotal) * 100;
      if (pctIncrease >= threshold) {
        triggerValue = pctIncrease;
      }
    }

    if (triggerValue !== null) {
      await pool.query('UPDATE alerts SET triggered_at = now(), trigger_value = $1 WHERE id = $2', [
        triggerValue,
        alert.id,
      ]);
      // #230 (notifications table) isn't implemented anywhere in this codebase
      // yet — see implementation.md for the scope reconciliation. Nothing to
      // insert into here until that lands.
    }
  }
}

importersRouter.post('/:id/upload-tariff-csv', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // #229: block tariff-driven collateral requirement changes until KYC is approved.
  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before tariff uploads',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const parse = TariffUploadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  // ── HTS statutory rate validation ──────────────────────────────────────────
  // Cross-reference every line item's declared duty rate against the USITC HTS
  // schedule before feeding the rates into the collateral computation.
  const htsValidation = await validateHtsRates(
    parse.data.lineItems.map((item) => ({
      hts_code: item.htsCode,
      declared_rate: item.dutyRate,
    }))
  );

  if (htsValidation.hasBlockingErrors) {
    res.status(422).json({
      error: 'HTS rate validation failed: one or more line items are underreported',
      flagged: htsValidation.blocking.map((r) => ({
        htsCode: r.hts_code,
        declaredRate: r.declared_rate,
        statutoryRate: r.statutory_rate,
        message: r.message,
      })),
    });
    return;
  }

  // Collect non-blocking warnings to surface in the response.
  const htsWarnings = htsValidation.warnings.map((r) => ({
    htsCode: r.hts_code,
    status: r.status,
    declaredRate: r.declared_rate,
    statutoryRate: r.statutory_rate,
    message: r.message,
  }));

  // ── Legacy CBP validation (kept for compatibility) ─────────────────────────
  let annualDutyTotal = 0;
  const validationReport = [];
  let hasBlockError = false;

  for (const item of parse.data.lineItems) {
    const cbpRes = await lookupCbpDutyRate(item.htsCode);
    const cbpRate = cbpRes.dutyRate ?? item.dutyRate;

    const deviation = Math.abs(cbpRate - item.dutyRate);
    if (cbpRate > 0 && deviation / cbpRate > 0.1) {
      validationReport.push({
        htsCode: item.htsCode,
        reportedRate: item.dutyRate,
        cbpRate: cbpRate,
        deviation,
      });
      if (env.CBP_VALIDATION_MODE !== 'warn') {
        hasBlockError = true;
      }
    }
    annualDutyTotal += item.value * item.dutyRate;
  }

  if (hasBlockError) {
    res.status(422).json({ error: 'CBP validation failed', report: validationReport });
    return;
  }

  // CBP rule of thumb: continuous bond face value ~= 10% of annual duties+taxes+fees.
  // We require importer to collateralize 50% of bond face value (industry-typical cash collateral demand for new importers).
  const bondFaceValue = annualDutyTotal * 0.1;
  const requiredCollateralUSD = bondFaceValue * 0.5;
  // Token is XLM in the demo (1 USD ≈ 1 XLM for stand-in); 7 decimals.
  const requiredStroops = BigInt(Math.round(requiredCollateralUSD * 1e7));

  // #233: captured before this upload is inserted, so it's genuinely the
  // *previous* upload for the percent_increase alert check below — not the
  // row this request is about to create.
  const previousUpload = await pool.query(
    'SELECT annual_duty_total FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1',
    [importer.id]
  );
  const previousAnnualDutyTotal =
    previousUpload.rowCount && previousUpload.rowCount > 0
      ? Number(previousUpload.rows[0]!.annual_duty_total)
      : null;

  try {
    const onChain = await contractClient.setRequiredCollateral(
      [platformKeypair],
      importer.stellar_address,
      requiredStroops,
      env.PRICE_ORACLE_CONTRACT_ID,
      false
    );
    await pool.query(
      'INSERT INTO tariff_uploads (importer_id, filename, annual_duty_total, computed_required_collateral, applied_tx) VALUES ($1, $2, $3, $4, $5)',
      [
        importer.id,
        parse.data.filename ?? null,
        annualDutyTotal,
        requiredStroops.toString(),
        onChain.txHash,
      ]
    );

    // #233: evaluate alert thresholds against this upload. Isolated in its
    // own try/catch, matching the friendbot-funding pattern earlier in this
    // file — the tariff upload and on-chain collateral update have already
    // succeeded by this point, so a bug in alert evaluation must not turn
    // into a 500 for an otherwise-successful request.
    try {
      await evaluateTariffAlerts(importer.id, annualDutyTotal, previousAnnualDutyTotal);
    } catch (err) {
      console.error('[importers] tariff alert evaluation failed:', err);
    }

    // #228: bare ON CONFLICT DO NOTHING — required now that contract_events is
    // partitioned; see lib/contract-events-partitions.ts.
    await pool.query(
      `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, ledger_sequence, event_index)
       VALUES ($1, 'required_changed', $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        importer.id,
        requiredStroops.toString(),
        onChain.txHash,
        onChain.ledgerSequence,
        onChain.applicationOrder,
      ]
    );

    await logAudit(user.id, 'apply_tariff_upload', importer.id, {
      filename: parse.data.filename,
      annualDutyTotal,
      requiredStroops: requiredStroops.toString(),
    });

    // #246 — required_collateral just changed on-chain; drop the cached
    // account so the next GET /importers/:id reads the new value instead of
    // serving a stale cache entry for up to 30s.
    await invalidateOnChainAccount(importer.id);

    // #1091: refresh cost scales with total importer/bond/event volume system-wide
    // (the view aggregates across ALL importers), not just this one upload, so as
    // that volume grows this REFRESH gets slower and is more likely to time out or
    // error under load. Isolated in its own try/catch, matching the alert-evaluation
    // pattern just above — the tariff upload and on-chain collateral update have
    // already succeeded by this point, so a slow/failed metrics refresh must not
    // turn into a 500 for an otherwise-successful request. The periodic refresh job
    // (see refreshImporterMetricsView's doc comment) remains as a backstop if this
    // on-demand refresh fails.
    try {
      await refreshImporterMetricsView();
    } catch (err) {
      console.error('[importers] importer_metrics refresh failed:', err);
    }

    res.json({
      annualDutyTotal,
      bondFaceValue,
      requiredCollateralStroops: requiredStroops.toString(),
      txHash: onChain.txHash,
      txUrl: explorerTx(onChain.txHash),
      htsWarnings: htsWarnings.length > 0 ? htsWarnings : undefined,
    });
  } catch (err: any) {
    const errMsg = String(err);
    if (errMsg.includes('Error(Contract, #13)') || errMsg.includes('RateLimitExceeded')) {
      const retryAfter = Math.ceil(Date.now() / 1000) + 86400;
      res.status(429).set('Retry-After', String(retryAfter)).json({
        error: 'rate limit exceeded',
        retryAfter,
        message: 'collateral requirements can only be updated once per 24 hours',
      });
      return;
    }
    throw err;
  }
});

const DepositSchema = z.object({
  amountStroops: z.string().regex(/^\d+$/),
  bucket: z.enum(['collateral', 'reserve']),
});

importersRouter.post('/:id/deposit', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // #312: block collateral deposits until KYC is approved (CIP compliance)
  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before collateral deposits',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const parse = DepositSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Transaction blocked pending AML review' });
    return;
  }

  const jobId = await enqueueTxSubmit({
    method: 'deposit',
    importerId: importer.id,
    keypairSecret: importer.stellar_secret_encrypted,
    args: {
      bucket: parse.data.bucket,
      importerAddress: importer.stellar_address,
      sourceAddress: importer.stellar_address,
      amountStroops: parse.data.amountStroops,
    },
  });
  await logAudit(user.id, 'deposit', importer.id, {
    bucket: parse.data.bucket,
    amountStroops: parse.data.amountStroops,
  });

  // #246 — the deposit tx submits asynchronously (see queue.ts), so this
  // only clears whatever was cached from before the deposit was queued; the
  // queue worker invalidates again once the tx actually lands on-chain.
  await invalidateOnChainAccount(importer.id);

  res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
});

importersRouter.post('/:id/auto-top-up', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // #229: block auto-top-up until KYC is approved (same rule as manual deposits).
  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before auto-top-up',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const jobId = await enqueueTxSubmit({
    method: 'auto_top_up',
    importerId: importer.id,
    platformKey: true,
    args: {
      importerAddress: importer.stellar_address,
    },
  });
  res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
});

const WithdrawSchema = z.object({
  amountStroops: z.string().regex(/^\d+$/),
});

importersRouter.post('/:id/withdraw', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // #229: block withdrawals until KYC is approved (same rule as deposits/auto-top-up).
  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before withdrawals',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const parse = WithdrawSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Transaction blocked pending AML review' });
    return;
  }

  const jobId = await enqueueTxSubmit({
    method: 'withdraw',
    importerId: importer.id,
    keypairSecret: importer.stellar_secret_encrypted,
    args: {
      importerAddress: importer.stellar_address,
      sourceAddress: importer.stellar_address,
      amountStroops: parse.data.amountStroops,
    },
  });
  await logAudit(user.id, 'withdraw', importer.id, { amountStroops: parse.data.amountStroops });

  // #246 — see the matching comment in POST /:id/deposit above: this covers
  // the pre-confirmation window, the queue worker invalidates again on completion.
  await invalidateOnChainAccount(importer.id);

  res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
});

// --- Surety admin actions ---

const YieldSchema = z.object({ amountStroops: z.string().regex(/^\d+$/) });

importersRouter.post(
  '/:id/accrue-yield',
  requireLicenseVerified,
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    if (user.role !== 'surety_admin') {
      res.status(403).json({ error: 'surety admin only' });
      return;
    }
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parse = YieldSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input' });
      return;
    }
    const jobId = await enqueueTxSubmit({
      method: 'accrue_yield',
      importerId: importer.id,
      platformKey: true,
      args: {
        importerAddress: importer.stellar_address,
        amountStroops: parse.data.amountStroops,
      },
    });
    res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
  }
);

importersRouter.post(
  '/:id/clawback',
  requireLicenseVerified,
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    if (user.role !== 'surety_admin') {
      res.status(403).json({ error: 'surety admin only' });
      return;
    }
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const jobId = await enqueueTxSubmit({
      method: 'clawback',
      importerId: importer.id,
      suretyKey: true,
      args: {
        importerAddress: importer.stellar_address,
      },
    });

    // #246 — see the matching comment in POST /:id/deposit above: this covers
    // the pre-confirmation window, the queue worker invalidates again on completion.
    await invalidateOnChainAccount(importer.id);

    res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
  }
);

// ── Issue #335: Oracle data reconciliation endpoint ───────────────────────────

const VerifyOracleSchema = z.object({
  as_of_date: z.string().datetime().optional(),
});

importersRouter.post('/:id/verify-oracle-data', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importerId = String(req.params.id ?? '');

  // Accessible by: the importer themselves, surety_admin, or platform admin (surety_admin covers both)
  let importer: Record<string, unknown> | null = null;
  if (user.role === 'surety_admin') {
    const r = await pool.query('SELECT * FROM importers WHERE id = $1', [importerId]);
    importer = r.rows[0] ?? null;
  } else {
    const r = await pool.query('SELECT * FROM importers WHERE id = $1 AND user_id = $2', [
      importerId,
      user.id,
    ]);
    importer = r.rows[0] ?? null;
  }
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = VerifyOracleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  // Fetch latest tariff upload for this importer
  const uploadQ = parse.data.as_of_date
    ? await pool.query(
        'SELECT * FROM tariff_uploads WHERE importer_id = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1',
        [importerId, parse.data.as_of_date]
      )
    : await pool.query(
        'SELECT * FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1',
        [importerId]
      );

  if (!uploadQ.rowCount || uploadQ.rowCount === 0) {
    res.status(404).json({ error: 'no tariff CSV data found for this importer' });
    return;
  }
  const upload = uploadQ.rows[0]!;

  // Re-derive: required = annual_duty * 10% * 50%
  const annualDuty = Number(upload.annual_duty_total);
  const computed = BigInt(Math.round(annualDuty * 0.1 * 0.5 * 1e7));

  // CSV hash — hash the stored annual_duty_total + filename as a stable fingerprint
  const csvFingerprint = `${upload.filename ?? ''}:${upload.annual_duty_total}`;
  const csvHash = createHash('sha256').update(csvFingerprint).digest('hex');

  // Fetch on-chain value
  const onChainStr = await getRequiredCollateralOnChain(importer.stellar_address as string);
  const onChain = BigInt(onChainStr);

  const computedNum = Number(computed);
  const onChainNum = Number(onChain);
  const deviationPct =
    onChainNum === 0
      ? computedNum === 0
        ? 0
        : 100
      : (Math.abs(computedNum - onChainNum) / onChainNum) * 100;

  const match = deviationPct <= 1.0;

  // Write reconciliation_failure alert if material mismatch
  if (!match && deviationPct > 1.0) {
    await pool.query(
      `INSERT INTO oracle_alerts (importer_id, old_value, new_value, pct_change, tx_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        importerId,
        onChainStr,
        computed.toString(),
        deviationPct.toFixed(2),
        'reconciliation_failure',
      ]
    );
  }

  res.json({
    computed: computed.toString(),
    on_chain: onChainStr,
    match,
    deviation_pct: Math.round(deviationPct * 100) / 100,
    csv_hash: csvHash,
    collateral_timestamp: (upload.created_at as Date).toISOString(),
  });
});

importersRouter.get('/:id/tx-status/:jobId', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const job = await txSubmitQueue.getJob(String(req.params.jobId ?? ''));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }

  const state = await job.getState();
  const progress = job.progress;
  const result = job.returnvalue;
  const failedReason = job.failedReason;

  if (state === 'completed') {
    res.json({ state, result });
  } else if (state === 'failed') {
    res.status(400).json({ state, error: failedReason });
  } else {
    res.json({ state, progress });
  }
});

// ── #232: GET /importers/:id/bonds — full bond history ──────────────────────

importersRouter.get('/:id/bonds', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, bond_number, policy_type, coverage_amount, status,
            issued_at, expires_at, replaced_by_id, stellar_contract_address, created_at
       FROM bonds WHERE importer_id = $1 ORDER BY created_at DESC`,
    [importer.id]
  );

  res.json({ bonds: r.rows });
});

// ── #234: bond application document storage (CBP Form 301, power of attorney,
// commercial invoices, KYC ID, etc.) ─────────────────────────────────────────
//
// Mirrors the same stubbed-upload convention already used by
// POST /importers/:id/kyc (routes/kyc.ts) and the compliance report PDF flow
// (jobs/compliance-report.ts, routes/compliance.ts): no multipart parser
// (multer/busboy) or AWS SDK client is installed anywhere in this codebase,
// so uploads are accepted as a base64 payload in the JSON body and the S3
// calls are stubbed behind `env.S3_DOCUMENTS_BUCKET`, exactly like those
// other document flows already do. See implementation.md for the full
// rationale.

const DOCUMENT_KINDS = [
  'cbp_301',
  'power_of_attorney',
  'commercial_invoice',
  'kyc_id',
  'other',
] as const;

// Stub: in production, use AWS SDK PutObjectCommand to S3_DOCUMENTS_BUCKET.
// Returns the object-storage key, which is what's persisted in documents.url.
async function uploadBondDocumentToStorage(
  importerId: string,
  kind: string,
  filename: string,
  _fileBuffer: Buffer
): Promise<string> {
  const timestamp = Date.now();
  const key = `documents/${importerId}/${kind}/${timestamp}-${filename}`;
  if (env.S3_DOCUMENTS_BUCKET) {
    // Production: AWS SDK upload would go here
    // const s3 = new S3Client({ region: env.AWS_REGION });
    // await s3.send(new PutObjectCommand({ Bucket: env.S3_DOCUMENTS_BUCKET, Key: key, Body: _fileBuffer, ContentType: mimeType }));
  }
  return key;
}

// Stub: in production, generate a pre-signed GetObjectCommand URL with 15-min TTL.
function generateBondDocumentDownloadUrl(key: string): string {
  if (env.S3_DOCUMENTS_BUCKET) {
    return `https://${env.S3_DOCUMENTS_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}?presigned=stub`;
  }
  return `/dev/documents-stub/${key}`;
}

// Stub: in production, use AWS SDK DeleteObjectCommand against S3_DOCUMENTS_BUCKET.
async function deleteBondDocumentFromStorage(_key: string): Promise<void> {
  if (env.S3_DOCUMENTS_BUCKET) {
    // Production: AWS SDK delete would go here
    // const s3 = new S3Client({ region: env.AWS_REGION });
    // await s3.send(new DeleteObjectCommand({ Bucket: env.S3_DOCUMENTS_BUCKET, Key: _key }));
  }
}

const UploadDocumentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  filename: z.string().min(1),
  fileBase64: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

// POST /importers/:id/documents — upload a bond application document
importersRouter.post('/:id/documents', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // zod's z.enum(DOCUMENT_KINDS) rejects any kind outside the five values the
  // documents.kind CHECK constraint allows, so an invalid kind 400s here
  // instead of surfacing as a raw Postgres constraint-violation error.
  const parse = UploadDocumentSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }
  const { kind, filename, fileBase64, mimeType, expiresAt } = parse.data;
  const fileBuffer = Buffer.from(fileBase64, 'base64');

  const storageKey = await uploadBondDocumentToStorage(importer.id, kind, filename, fileBuffer);

  const inserted = await pool.query(
    `INSERT INTO documents (importer_id, kind, filename, url, mime_type, size_bytes, uploaded_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, kind, filename, mime_type, size_bytes, expires_at, created_at`,
    [
      importer.id,
      kind,
      filename,
      storageKey,
      mimeType ?? null,
      fileBuffer.length,
      user.id,
      expiresAt ?? null,
    ]
  );
  const document = inserted.rows[0]!;

  await logAudit(user.id, 'document_upload', importer.id, {
    documentId: document.id,
    kind,
    filename,
  });

  res.status(201).json({ document });
});

// GET /importers/:id/documents — list documents with signed download URLs
importersRouter.get('/:id/documents', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // idx_documents_importer_kind (importer_id, kind, created_at DESC) makes the
  // importer_id filter an index range scan; because this query doesn't also
  // filter on kind, the created_at DESC ordering isn't fully free from the
  // index (it's only pre-sorted within each kind group) — Postgres still
  // performs a sort, cheaply, since a single importer's document count is
  // small (a handful of bond-application PDFs, not an unbounded table).
  const r = await pool.query(
    `SELECT id, kind, filename, url, mime_type, size_bytes, expires_at, created_at
       FROM documents WHERE importer_id = $1 ORDER BY created_at DESC`,
    [importer.id]
  );

  const documents = r.rows.map((d) => ({
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    mimeType: d.mime_type,
    sizeBytes: d.size_bytes,
    expiresAt: d.expires_at,
    createdAt: d.created_at,
    downloadUrl: generateBondDocumentDownloadUrl(d.url),
    expiresInSeconds: 900,
  }));

  res.json({ documents });
});

// DELETE /importers/:id/documents/:docId — surety_admin only
importersRouter.delete('/:id/documents/:docId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const existing = await pool.query(
    'SELECT id, kind, filename, url FROM documents WHERE id = $1 AND importer_id = $2',
    [req.params.docId, importer.id]
  );
  const doc = existing.rows[0];
  if (!doc) {
    res.status(404).json({ error: 'document not found' });
    return;
  }

  await deleteBondDocumentFromStorage(doc.url);
  await pool.query('DELETE FROM documents WHERE id = $1', [doc.id]);

  await logAudit(user.id, 'document_delete', importer.id, {
    documentId: doc.id,
    kind: doc.kind,
    filename: doc.filename,
  });

  res.json({ success: true });
});
