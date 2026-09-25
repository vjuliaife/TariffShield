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
  createNotification,
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
  s3KeyEncrypt,
  s3KeyDecrypt,
  uploadDocumentToS3,
  generatePresignedUrl,
  scanDocumentBuffer,
  KYC_MAX_FILE_BYTES,
  type VirusScanStatus,
} from './kyc.js';
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
import { hasActiveBrokerGrant } from './broker.js';
import { env } from '../config/env.js';
import { enqueueTxSubmit, txSubmitQueue } from '../queue.js';
import {
  getActiveCreditLines,
  evaluateCollateralHealth,
} from '../services/credit-lines.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import {
  getCachedOnChainAccount,
  setCachedOnChainAccount,
  invalidateOnChainAccount,
  type OnChainAccountView,
} from '../cache.js';
import { computeNextRunAt } from '../services/deposit-schedules.js';

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
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
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
      `SELECT DISTINCT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at
         FROM importers i
         LEFT JOIN importer_team_members tm ON tm.importer_id = i.id AND tm.user_id = $1 AND tm.status = 'active'
         WHERE i.user_id = $1 OR tm.user_id IS NOT NULL
         ORDER BY i.created_at DESC`,
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
    res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
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
    // #1009 — the review endpoint now also reports the multi-step approval
    // chain state (current step + every recorded decision) alongside the
    // single-query document review payload.
    const approval = await getApprovalState(importerId);
    res.json({ review, approval });
  } catch (err: any) {
    console.error('[importers] Failed to query importer review:', err);
    res.status(500).json({ error: 'failed to retrieve importer review' });
  }
});

// ── #1009: Configurable multi-step approval chains ─────────────────────────
//
// surety_admin defines ordered chains (e.g. underwriter → compliance officer)
// with a required role per step. Instances snapshot the chain's steps so an
// in-flight review is unaffected by later chain versions; approval only
// finalises (importer approved) once every step has approved, and any
// rejection halts the chain and notifies the importer. Each step must be
// approved by a different surety admin — multi-person sign-off.

interface ApprovalChainStep {
  step_number: number;
  name: string;
  required_role: 'underwriter' | 'compliance_officer' | 'surety_admin';
}

const ApprovalStepSchema = z.object({
  name: z.string().min(1).max(120),
  requiredRole: z.enum(['underwriter', 'compliance_officer', 'surety_admin']),
});

const CreateApprovalChainSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(ApprovalStepSchema).min(1).max(10),
});

async function getApprovalState(importerId: string): Promise<{
  instance: Record<string, unknown>;
  steps: ApprovalChainStep[];
  decisions: Array<Record<string, unknown>>;
  currentStep: number;
  status: string;
} | null> {
  const instanceResult = await pool.query(
    `SELECT aci.id, aci.chain_id, aci.chain_version, aci.importer_id, aci.steps,
            aci.current_step, aci.status, aci.started_by, aci.decided_at, aci.created_at,
            ac.name AS chain_name
     FROM approval_chain_instances aci
     JOIN approval_chains ac ON ac.id = aci.chain_id
     WHERE aci.importer_id = $1
     ORDER BY aci.created_at DESC
     LIMIT 1`,
    [importerId]
  );
  const row = instanceResult.rows[0];
  if (!row) return null;

  const decisions = await pool.query(
    `SELECT d.step_number, d.required_role, d.step_name, d.approver_id, u.email AS approver_email,
            d.decision, d.note, d.decided_at
     FROM approval_chain_decisions d
     JOIN users u ON u.id = d.approver_id
     WHERE d.instance_id = $1
     ORDER BY d.step_number ASC`,
    [row.id]
  );

  return {
    instance: {
      id: row.id,
      chainId: row.chain_id,
      chainName: row.chain_name,
      chainVersion: row.chain_version,
      importerId: row.importer_id,
      startedBy: row.started_by,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
    },
    steps: row.steps as ApprovalChainStep[],
    decisions: decisions.rows,
    currentStep: row.current_step,
    status: row.status,
  };
}

// GET /importers/admin/approval-chains — list every chain version (auditable).
importersRouter.get('/admin/approval-chains', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }
  const result = await pool.query(
    `SELECT id, name, version, scope, steps, is_active, created_by, created_at
     FROM approval_chains
     ORDER BY name ASC, version DESC`
  );
  res.json({ chains: result.rows });
});

// POST /importers/admin/approval-chains — create the next version of a named
// chain (versioning: same name ⇒ version + 1, prior versions deactivated).
importersRouter.post('/admin/approval-chains', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  const parse = CreateApprovalChainSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }
  const { name, steps } = parse.data;

  const normalizedSteps: ApprovalChainStep[] = steps.map((s, i) => ({
    step_number: i + 1,
    name: s.name,
    required_role: s.requiredRole,
  }));

  try {
    const created = await pool.query(
      `WITH next_version AS (
         SELECT COALESCE(MAX(version), 0) + 1 AS version FROM approval_chains WHERE name = $1
       ), deactivated AS (
         UPDATE approval_chains SET is_active = FALSE WHERE name = $1 AND is_active
       )
       INSERT INTO approval_chains (name, version, steps, created_by)
       SELECT $1, nv.version, $2::jsonb, $3 FROM next_version nv
       RETURNING id, name, version, scope, steps, is_active, created_by, created_at`,
      [name, JSON.stringify(normalizedSteps), user.id]
    );
    const chain = created.rows[0];

    await logAudit(user.id, 'approval_chain_created', chain.id, {
      name,
      version: chain.version,
      steps: normalizedSteps,
    });

    res.status(201).json({ chain });
  } catch (err: any) {
    console.error('[importers] failed to create approval chain:', err);
    res.status(500).json({ error: 'failed to create approval chain' });
  }
});

// POST /importers/admin/:id/review/start — open a chain instance for this
// importer's review (uses the latest active chain unless chainId is given).
importersRouter.post('/admin/:id/review/start', async (req: Request, res: Response) => {
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
  const parse = z.object({ chainId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  try {
    const importer = await pool.query(
      'SELECT id FROM importers WHERE id = $1 AND deleted_at IS NULL',
      [importerId]
    );
    if (!importer.rowCount) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    let chainResult;
    if (parse.data.chainId) {
      chainResult = await pool.query(
        'SELECT id, name, version, steps FROM approval_chains WHERE id = $1',
        [parse.data.chainId]
      );
      if (!chainResult.rowCount) {
        res.status(404).json({ error: 'approval chain not found' });
        return;
      }
    } else {
      chainResult = await pool.query(
        `SELECT id, name, version, steps FROM approval_chains
         WHERE is_active
         ORDER BY created_at DESC LIMIT 1`
      );
      if (!chainResult.rowCount) {
        res.status(400).json({ error: 'no active approval chain configured' });
        return;
      }
    }
    const chain = chainResult.rows[0];

    const existing = await pool.query(
      `SELECT id FROM approval_chain_instances
       WHERE importer_id = $1 AND status = 'in_progress'`,
      [importerId]
    );
    if (existing.rowCount) {
      res.status(409).json({ error: 'a review is already in progress for this importer' });
      return;
    }

    const instanceResult = await pool.query(
      `INSERT INTO approval_chain_instances
         (chain_id, chain_version, importer_id, steps, started_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, chain_id, chain_version, importer_id, steps, current_step, status,
                 started_by, decided_at, created_at`,
      [chain.id, chain.version, importerId, JSON.stringify(chain.steps), user.id]
    );

    await logAudit(user.id, 'review_chain_started', importerId, {
      instanceId: instanceResult.rows[0].id,
      chainId: chain.id,
      chainVersion: chain.version,
      chainName: chain.name,
    });

    const approval = await getApprovalState(importerId);
    res.status(201).json({ approval });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'a review is already in progress for this importer' });
      return;
    }
    console.error('[importers] failed to start review chain:', err);
    res.status(500).json({ error: 'failed to start review chain' });
  }
});

// POST /importers/admin/:id/review/decision — record the current step's
// decision. Approval advances (or finalises on the last step); rejection
// halts the chain and notifies the importer.
importersRouter.post('/admin/:id/review/decision', async (req: Request, res: Response) => {
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
  const parse = z
    .object({
      decision: z.enum(['approved', 'rejected']),
      note: z.string().max(1000).optional(),
    })
    .safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }
  const { decision, note } = parse.data;

  try {
    const open = await pool.query(
      `SELECT id, chain_version, steps, current_step, status
       FROM approval_chain_instances
       WHERE importer_id = $1 AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [importerId]
    );
    if (!open.rowCount) {
      res.status(404).json({ error: 'no review in progress for this importer' });
      return;
    }
    const instance = open.rows[0];
    const steps = instance.steps as ApprovalChainStep[];
    const stepIndex = Number(instance.current_step) - 1;
    const step = steps[stepIndex];
    if (!step) {
      res.status(500).json({ error: 'chain state is inconsistent with its steps' });
      return;
    }

    // Multi-person sign-off: every step needs a different surety admin.
    const priorApprover = await pool.query(
      'SELECT approver_id FROM approval_chain_decisions WHERE instance_id = $1 AND approver_id = $2',
      [instance.id, user.id]
    );
    if (priorApprover.rowCount) {
      res
        .status(403)
        .json({ error: 'a different surety admin must record each approval step' });
      return;
    }

    await pool.query(
      `INSERT INTO approval_chain_decisions
         (instance_id, step_number, required_role, step_name, approver_id, decision, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [instance.id, step.step_number, step.required_role, step.name, user.id, decision, note ?? null]
    );

    const isLastStep = step.step_number >= steps.length;
    let finalized = false;
    let halted = false;
    let importerKycStatus: string | null = null;

    if (decision === 'rejected') {
      halted = true;
      await pool.query(
        `UPDATE approval_chain_instances SET status = 'rejected', decided_at = now() WHERE id = $1`,
        [instance.id]
      );
      await logAudit(user.id, 'review_chain_rejected', importerId, {
        instanceId: instance.id,
        stepNumber: step.step_number,
        stepName: step.name,
        note: note ?? null,
      });

      const owner = await pool.query('SELECT user_id FROM importers WHERE id = $1', [importerId]);
      if (owner.rows[0]?.user_id) {
        await createNotification(
          owner.rows[0].user_id,
          NOTIFICATION_KINDS.REVIEW_CHAIN_REJECTED,
          `Your surety review was rejected at step ${step.step_number} ("${step.name}"). Contact your surety for next steps.`
        );
      }
    } else if (isLastStep) {
      finalized = true;
      await pool.query(
        `UPDATE approval_chain_instances SET status = 'approved', decided_at = now() WHERE id = $1`,
        [instance.id]
      );
      // Finalisation only happens here — after every step has approved.
      const kycResult = await pool.query(
        `UPDATE importers SET kyc_status = 'approved'
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING kyc_status`,
        [importerId]
      );
      importerKycStatus = kycResult.rows[0]?.kyc_status ?? null;

      await logAudit(user.id, 'review_chain_finalized', importerId, {
        instanceId: instance.id,
        chainVersion: instance.chain_version,
        steps: steps.length,
        importerKycStatus,
      });

      const owner = await pool.query('SELECT user_id FROM importers WHERE id = $1', [importerId]);
      if (owner.rows[0]?.user_id) {
        await createNotification(
          owner.rows[0].user_id,
          NOTIFICATION_KINDS.REVIEW_CHAIN_APPROVED,
          'Your surety review was approved — all approval steps have signed off.'
        );
      }
    } else {
      await pool.query(
        `UPDATE approval_chain_instances SET current_step = current_step + 1 WHERE id = $1`,
        [instance.id]
      );
      await logAudit(user.id, 'review_chain_step_approved', importerId, {
        instanceId: instance.id,
        stepNumber: step.step_number,
        stepName: step.name,
        nextStep: step.step_number + 1,
      });
    }

    const approval = await getApprovalState(importerId);
    res.json({ approval, finalized, halted, importerKycStatus });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'this step has already been decided' });
      return;
    }
    console.error('[importers] failed to record review decision:', err);
    res.status(500).json({ error: 'failed to record review decision' });
  }
});

async function loadImporterFor(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  // If request is authenticated with an importer-scoped API key, strictly enforce importer scoping (#995)
  if (user.apiKeyId && user.importerId) {
    if (importerId !== user.importerId) {
      return null;
    }
  }
  if (user.role === 'surety_admin') {
    const r = await pool.query('SELECT * FROM importers WHERE id = $1', [importerId]);
    return r.rows[0] ?? null;
  }
  if (user.role === 'broker') {
    if (req.method !== 'GET') return null;
    const granted = await hasActiveBrokerGrant(user.id, importerId);
    if (!granted) return null;
    const r = await pool.query('SELECT * FROM importers WHERE id = $1', [importerId]);
    return r.rows[0] ?? null;
  }

  // Check direct ownership or active team membership (#1015)
  const r = await pool.query(
    `SELECT i.*, 
            CASE 
              WHEN i.user_id = $2 THEN 'owner'
              ELSE tm.role::text
            END as member_role
     FROM importers i
     LEFT JOIN importer_team_members tm 
       ON tm.importer_id = i.id AND tm.user_id = $2 AND tm.status = 'active'
     WHERE i.id = $1 AND (i.user_id = $2 OR tm.user_id IS NOT NULL)`,
    [importerId, user.id]
  );
  const importer = r.rows[0];
  if (!importer) return null;

  // Enforce role-based permission boundaries:
  // Viewer role is read-only (GET requests only)
  if (importer.member_role === 'viewer' && req.method !== 'GET') {
    return null;
  }

  return importer;
}

// ── #1015: Importer Team Member Management Endpoints ─────────────────────────

const InviteTeamMemberSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum(['admin', 'finance', 'viewer']).default('viewer'),
});

// GET /importers/:id/members — list team members for importer
importersRouter.get('/:id/members', async (req: Request, res: Response) => {
  const importerId = String(req.params.id ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const result = await pool.query(
    `SELECT tm.id, tm.email, tm.role, tm.status, tm.invited_at, tm.accepted_at, tm.revoked_at,
            u.id AS user_id
     FROM importer_team_members tm
     LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.importer_id = $1
     ORDER BY tm.invited_at DESC`,
    [importerId]
  );

  res.json({ members: result.rows });
});

// POST /importers/:id/members/invite — invite team member
importersRouter.post('/:id/members/invite', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importerId = String(req.params.id ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Only owner or team members with role 'owner' / 'admin' can invite
  if (importer.user_id !== user.id && importer.member_role !== 'admin') {
    res.status(403).json({ error: 'only owner or importer admin can invite team members' });
    return;
  }

  const parse = InviteTeamMemberSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }
  const { email, role } = parse.data;

  const rawToken = createHash('sha256').update(randomBytes(32)).digest('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  try {
    const inserted = await pool.query(
      `INSERT INTO importer_team_members (importer_id, email, role, status, invite_token_hash, invited_by)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       ON CONFLICT (importer_id, email) DO UPDATE
         SET role = EXCLUDED.role,
             status = 'pending',
             invite_token_hash = EXCLUDED.invite_token_hash,
             invited_by = EXCLUDED.invited_by,
             invited_at = NOW(),
             revoked_at = NULL
       RETURNING id, importer_id, email, role, status, invited_at`,
      [importerId, email, role, tokenHash, user.id]
    );

    await logAudit(user.id, 'team_member_invited', importerId, { email, role });

    res.status(201).json({
      invite: {
        ...inserted.rows[0],
        token: rawToken,
      },
    });
  } catch (err: any) {
    console.error('[importers] failed to invite team member:', err);
    res.status(500).json({ error: 'failed to invite team member' });
  }
});

// DELETE /importers/:id/members/:memberId — revoke team member access
importersRouter.delete('/:id/members/:memberId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importerId = String(req.params.id ?? '');
  const memberId = String(req.params.memberId ?? '');

  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (importer.user_id !== user.id && importer.member_role !== 'admin') {
    res.status(403).json({ error: 'only owner or importer admin can revoke team members' });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE importer_team_members
       SET status = 'revoked', revoked_at = NOW()
       WHERE id = $1 AND importer_id = $2
       RETURNING id, email, status, revoked_at`,
      [memberId, importerId]
    );

    if (!result.rowCount) {
      res.status(404).json({ error: 'team member not found' });
      return;
    }

    await logAudit(user.id, 'team_member_revoked', importerId, { memberId });

    res.json({ member: result.rows[0] });
  } catch (err: any) {
    console.error('[importers] failed to revoke team member:', err);
    res.status(500).json({ error: 'failed to revoke team member' });
  }
});


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
    res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
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

// ── #992 / #994: Collateral history view with retained dispute evidence and scheduled withdrawals ─────
importersRouter.get('/:id/collateral-history', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // 1. Fetch on-chain collateral history (best-effort)
  let history: Array<{ value: string; timestamp: string }> = [];
  try {
    const rawHistory = await contractClient.getCollateralHistory(importer.stellar_address);
    history = rawHistory.map((e) => ({
      value: e.value.toString(),
      timestamp: new Date(Number(e.timestamp) * 1000).toISOString(),
    }));
  } catch (err) {
    req.log?.warn?.({ err, importerId: importer.id }, 'on-chain collateral history fetch failed');
  }

  // 2. Fetch all disputes (open and resolved) along with retained evidence (#992)
  const disputesRes = await pool.query(
    `SELECT id, importer_id, old_required::text AS old_required, new_required::text AS new_required,
            raise_tx_hash, status, raised_at, resolved_at, resolve_tx_hash
     FROM collateral_disputes
     WHERE importer_id = $1
     ORDER BY raised_at DESC`,
    [importer.id]
  );

  const disputeIds = disputesRes.rows.map((d) => d.id);
  const evidenceByDispute = new Map<string, any[]>();
  if (disputeIds.length > 0) {
    try {
      const evRes = await pool.query(
        `SELECT id, dispute_id, importer_id, file_name, mime_type, file_size_bytes,
                s3_key_encrypted, virus_scan_status, notes, created_at
         FROM dispute_evidence
         WHERE dispute_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [disputeIds]
      );
      for (const ev of evRes.rows) {
        const list = evidenceByDispute.get(ev.dispute_id) ?? [];
        list.push({
          id: ev.id,
          disputeId: ev.dispute_id,
          importerId: ev.importer_id,
          fileName: ev.file_name,
          mimeType: ev.mime_type,
          fileSizeBytes: ev.file_size_bytes,
          virusScanStatus: ev.virus_scan_status,
          notes: ev.notes,
          createdAt: ev.created_at,
          downloadUrl: ev.s3_key_encrypted
            ? generatePresignedUrl(s3KeyDecrypt(ev.s3_key_encrypted))
            : null,
        });
        evidenceByDispute.set(ev.dispute_id, list);
      }
    } catch {
      // Table might not exist yet before migration
    }
  }

  const disputes = disputesRes.rows.map((d) => ({
    ...d,
    evidence: evidenceByDispute.get(d.id) ?? [],
  }));

  // 3. Fetch scheduled withdrawals (#994)
  let scheduledWithdrawals: any[] = [];
  try {
    const swRes = await pool.query(
      `SELECT id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
              target_date, target_address, status, execution_result, executed_at, job_id, created_at
       FROM scheduled_withdrawals
       WHERE importer_id = $1
       ORDER BY target_date ASC`,
      [importer.id]
    );
    scheduledWithdrawals = swRes.rows;
  } catch {
    scheduledWithdrawals = [];
  }

  res.json({
    importerId: importer.id,
    history,
    disputes,
    scheduledWithdrawals,
  });
});

// ── #1007: credit-line visibility + credit-line-aware collateral health ─────

// GET /importers/:id/credit-lines — active and historical credit lines for
// the importer (owner) or any surety_admin.
importersRouter.get('/:id/credit-lines', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const result = await pool.query(
    `SELECT id, importer_id, granted_by, amount::text AS amount, reason, status,
            granted_at, expires_at, revoked_at, revoked_by, notified_expiring, created_at
     FROM credit_lines
     WHERE importer_id = $1
     ORDER BY created_at DESC`,
    [importer.id]
  );
  res.json({ creditLines: result.rows });
});

// GET /importers/:id/collateral-health — the credit-line-aware health check.
// Active credit lines count as temporary coverage of any shortfall; once a
// line expires (or is revoked) it disappears from the calculation and the
// strict requirement applies again.
importersRouter.get('/:id/collateral-health', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  try {
    const [acct, creditLines] = await Promise.all([
      contractClient.getAccount(importer.stellar_address),
      getActiveCreditLines(importer.id),
    ]);
    const health = evaluateCollateralHealth({
      balance: BigInt(acct.collateralBalance),
      requiredCollateral: BigInt(acct.requiredCollateral),
      creditLines,
    });
    res.json({
      health,
      strict: evaluateCollateralHealth({
        balance: BigInt(acct.collateralBalance),
        requiredCollateral: BigInt(acct.requiredCollateral),
        creditLines: [],
      }),
    });
  } catch (err) {
    console.error('[importers] failed to assess collateral health:', err);
    res.status(502).json({ error: 'failed to assess collateral health' });
  }
});

// --- Synthetic CBP tariff CSV upload — recomputes required_collateral on-chain ---

const TariffLineItemSchema = z.object({
  sku: z.string().optional(),
  htsCode: z.string().optional(),
  value: z.coerce.number().positive(),
  dutyRate: z.coerce.number().min(0).optional(),
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
      // yet. Nothing to insert into here until that lands.
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
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  // ── SKU Mapping Resolution ────────────────────────────────────────────────
  // Resolve any items carrying a product SKU against the importer's active catalog mapping.
  const activeMappings = await pool.query(
    'SELECT sku, hts_code, duty_rate FROM importer_sku_mappings WHERE importer_id = $1 AND is_active = true',
    [importer.id]
  );
  const skuMap = new Map<string, { htsCode: string; dutyRate?: number }>();
  for (const row of activeMappings.rows) {
    skuMap.set(row.sku, {
      htsCode: row.hts_code,
      dutyRate:
        row.duty_rate !== null && row.duty_rate !== undefined ? Number(row.duty_rate) : undefined,
    });
  }

  const unmappedSkus: string[] = [];
  const resolvedLineItems: Array<{
    sku?: string;
    htsCode: string;
    value: number;
    dutyRate: number;
  }> = [];

  for (const item of parse.data.lineItems) {
    let htsCode = item.htsCode;
    let dutyRate = item.dutyRate;

    if (!htsCode && item.sku) {
      const mapped = skuMap.get(item.sku);
      if (mapped) {
        htsCode = mapped.htsCode;
        if (dutyRate === undefined && mapped.dutyRate !== undefined) {
          dutyRate = mapped.dutyRate;
        }
      } else {
        unmappedSkus.push(item.sku);
      }
    } else if (!htsCode) {
      unmappedSkus.push(item.sku || 'UNKNOWN_SKU');
    }

    if (htsCode) {
      resolvedLineItems.push({
        sku: item.sku,
        htsCode,
        value: item.value,
        dutyRate: dutyRate ?? 0,
      });
    }
  }

  if (unmappedSkus.length > 0) {
    res.status(422).json({
      error: 'Unmapped SKUs found in tariff upload',
      unmappedSkus: Array.from(new Set(unmappedSkus)),
    });
    return;
  }

  // ── HTS statutory rate validation ──────────────────────────────────────────
  // Cross-reference every line item's declared duty rate against the USITC HTS
  // schedule before feeding the rates into the collateral computation.
  const htsValidation = await validateHtsRates(
    resolvedLineItems.map((item) => ({
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

  for (const item of resolvedLineItems) {
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
    res.status(400).json({ error: 'invalid input', target: 'body' });
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

// ── #992: Evidence Attachments on raise_dispute Submissions ───────────────────

const AttachDisputeEvidenceSchema = z
  .object({
    disputeId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
    fileName: z.string().max(255).optional(),
    fileBase64: z.string().min(1).optional(),
    mimeType: z.string().regex(/^(application\/pdf|image\/(png|jpeg))$/).optional(),
  })
  .refine((data) => (data.notes && data.notes.trim().length > 0) || Boolean(data.fileBase64), {
    message: 'Either notes or fileBase64 must be provided as evidence',
  });

async function handleAttachDisputeEvidence(req: Request, res: Response): Promise<void> {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = AttachDisputeEvidenceSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const targetDisputeId = req.params.disputeId || parse.data.disputeId;
  let disputeRow: any;
  if (targetDisputeId) {
    const r = await pool.query(
      'SELECT id, importer_id, status FROM collateral_disputes WHERE id = $1 AND importer_id = $2',
      [targetDisputeId, importer.id]
    );
    if (!r.rowCount) {
      res.status(404).json({ error: 'dispute not found' });
      return;
    }
    disputeRow = r.rows[0]!;
  } else {
    const r = await pool.query(
      `SELECT id, importer_id, status FROM collateral_disputes
       WHERE importer_id = $1 AND status = 'open'
       ORDER BY raised_at DESC LIMIT 1`,
      [importer.id]
    );
    if (!r.rowCount) {
      res.status(404).json({ error: 'no open dispute found for importer' });
      return;
    }
    disputeRow = r.rows[0]!;
  }

  // Attempting to attach evidence after resolve_dispute is rejected (#992 AC 5)
  if (disputeRow.status !== 'open') {
    res.status(409).json({ error: 'dispute is already resolved; cannot attach evidence' });
    return;
  }

  let s3KeyEncrypted: string | null = null;
  let virusScanStatus: VirusScanStatus = 'clean';
  let fileSizeBytes: number | null = null;

  if (parse.data.fileBase64) {
    const fileBuffer = Buffer.from(parse.data.fileBase64, 'base64');
    if (fileBuffer.length === 0) {
      res.status(400).json({ error: 'file is empty' });
      return;
    }
    if (fileBuffer.length > KYC_MAX_FILE_BYTES) {
      res.status(413).json({ error: `file exceeds ${KYC_MAX_FILE_BYTES} byte limit` });
      return;
    }
    const mimeType = parse.data.mimeType ?? 'application/pdf';
    virusScanStatus = scanDocumentBuffer(fileBuffer, mimeType);
    if (virusScanStatus === 'infected') {
      res.status(422).json({ error: 'virus detected in uploaded document' });
      return;
    }

    const s3Key = await uploadDocumentToS3(importer.id, 'dispute_evidence', fileBuffer, mimeType);
    s3KeyEncrypted = s3KeyEncrypt(s3Key);
    fileSizeBytes = fileBuffer.length;
  }

  const inserted = await pool.query(
    `INSERT INTO dispute_evidence (dispute_id, importer_id, file_name, mime_type, file_size_bytes, s3_key_encrypted, virus_scan_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, dispute_id, importer_id, file_name, mime_type, file_size_bytes, virus_scan_status, notes, created_at`,
    [
      disputeRow.id,
      importer.id,
      parse.data.fileName ?? null,
      parse.data.mimeType ?? null,
      fileSizeBytes,
      s3KeyEncrypted,
      virusScanStatus,
      parse.data.notes ?? null,
    ]
  );

  const evidence = inserted.rows[0]!;

  await logAudit(user.id, 'dispute_evidence_attached', importer.id, {
    disputeId: disputeRow.id,
    evidenceId: evidence.id,
    fileName: parse.data.fileName ?? null,
    hasNotes: Boolean(parse.data.notes),
  });

  res.status(201).json({
    evidence: {
      ...evidence,
      downloadUrl: s3KeyEncrypted ? generatePresignedUrl(s3KeyDecrypt(s3KeyEncrypted)) : null,
    },
  });
}

// Attach evidence to open dispute (with or without disputeId in URL)
importersRouter.post('/:id/disputes/evidence', handleAttachDisputeEvidence);
importersRouter.post('/:id/disputes/:disputeId/evidence', handleAttachDisputeEvidence);

// List evidence for an importer's dispute
importersRouter.get('/:id/disputes/:disputeId/evidence', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const disputeId = req.params.disputeId;
  const evRes = await pool.query(
    `SELECT id, dispute_id, importer_id, file_name, mime_type, file_size_bytes,
            s3_key_encrypted, virus_scan_status, notes, created_at
     FROM dispute_evidence
     WHERE dispute_id = $1 AND importer_id = $2
     ORDER BY created_at ASC`,
    [disputeId, importer.id]
  );
  const evidence = evRes.rows.map((row) => ({
    id: row.id,
    disputeId: row.dispute_id,
    importerId: row.importer_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    virusScanStatus: row.virus_scan_status,
    notes: row.notes,
    createdAt: row.created_at,
    downloadUrl: row.s3_key_encrypted
      ? generatePresignedUrl(s3KeyDecrypt(row.s3_key_encrypted))
      : null,
  }));
  res.json({ evidence });
});

importersRouter.get('/:id/disputes/evidence', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const openDispute = await pool.query(
    `SELECT id FROM collateral_disputes WHERE importer_id = $1 AND status = 'open' ORDER BY raised_at DESC LIMIT 1`,
    [importer.id]
  );
  if (!openDispute.rowCount) {
    res.status(404).json({ error: 'no open dispute found' });
    return;
  }
  const disputeId = openDispute.rows[0]!.id;
  const evRes = await pool.query(
    `SELECT id, dispute_id, importer_id, file_name, mime_type, file_size_bytes,
            s3_key_encrypted, virus_scan_status, notes, created_at
     FROM dispute_evidence
     WHERE dispute_id = $1 AND importer_id = $2
     ORDER BY created_at ASC`,
    [disputeId, importer.id]
  );
  const evidence = evRes.rows.map((row) => ({
    id: row.id,
    disputeId: row.dispute_id,
    importerId: row.importer_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    virusScanStatus: row.virus_scan_status,
    notes: row.notes,
    createdAt: row.created_at,
    downloadUrl: row.s3_key_encrypted
      ? generatePresignedUrl(s3KeyDecrypt(row.s3_key_encrypted))
      : null,
  }));
  res.json({ disputeId, evidence });
});

// ── #993: Recurring Collateral Deposit Scheduling ───────────────────────────

const CreateDepositScheduleSchema = z.object({
  cadence: z.enum(['weekly', 'monthly']),
  amountStroops: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, {
      message: 'amountStroops must be a positive integer',
    }),
  bucket: z.enum(['collateral', 'reserve']).default('collateral').optional(),
  startDate: z.string().optional(),
});

const UpdateDepositScheduleSchema = z.object({
  cadence: z.enum(['weekly', 'monthly']).optional(),
  amountStroops: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, {
      message: 'amountStroops must be a positive integer',
    })
    .optional(),
  bucket: z.enum(['collateral', 'reserve']).optional(),
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
});

// POST /importers/:id/deposit-schedule — configure recurring deposit schedule
importersRouter.post('/:id/deposit-schedule', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before collateral deposit scheduling',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const parse = CreateDepositScheduleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Transaction blocked pending AML review' });
    return;
  }

  let nextRunAt: Date;
  if (parse.data.startDate) {
    const parsedStart = new Date(parse.data.startDate);
    if (!isNaN(parsedStart.getTime()) && parsedStart.getTime() > Date.now()) {
      nextRunAt = parsedStart;
    } else {
      nextRunAt = computeNextRunAt(parse.data.cadence, new Date());
    }
  } else {
    nextRunAt = computeNextRunAt(parse.data.cadence, new Date());
  }

  const inserted = await pool.query(
    `INSERT INTO deposit_schedules (importer_id, user_id, cadence, amount_stroops, bucket, status, next_run_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6)
     RETURNING id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
               bucket, status, next_run_at, last_run_at, created_at, updated_at`,
    [
      importer.id,
      user.id,
      parse.data.cadence,
      parse.data.amountStroops,
      parse.data.bucket ?? 'collateral',
      nextRunAt,
    ]
  );

  const schedule = inserted.rows[0]!;

  await logAudit(user.id, 'create_deposit_schedule', importer.id, {
    scheduleId: schedule.id,
    cadence: parse.data.cadence,
    amountStroops: parse.data.amountStroops,
    bucket: parse.data.bucket ?? 'collateral',
  });

  res.status(201).json({ schedule });
});

// GET /importers/:id/deposit-schedule & GET /importers/:id/deposit-schedules — list active/all schedules
async function handleListDepositSchedules(req: Request, res: Response): Promise<void> {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
            bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at
     FROM deposit_schedules
     WHERE importer_id = $1
     ORDER BY created_at DESC`,
    [importer.id]
  );

  res.json({ schedules: r.rows });
}

importersRouter.get('/:id/deposit-schedule', handleListDepositSchedules);
importersRouter.get('/:id/deposit-schedules', handleListDepositSchedules);

// GET /importers/:id/deposit-schedule/history & GET /importers/:id/deposit-schedules/history
async function handleListDepositScheduleHistory(req: Request, res: Response): Promise<void> {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, schedule_id, importer_id, amount_stroops::text AS amount_stroops,
            bucket, status, job_id, error_message, executed_at
     FROM deposit_schedule_executions
     WHERE importer_id = $1
     ORDER BY executed_at DESC`,
    [importer.id]
  );

  res.json({ history: r.rows });
}

importersRouter.get('/:id/deposit-schedule/history', handleListDepositScheduleHistory);
importersRouter.get('/:id/deposit-schedules/history', handleListDepositScheduleHistory);

// GET /importers/:id/deposit-schedule/:scheduleId — get single schedule
importersRouter.get('/:id/deposit-schedule/:scheduleId', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
            bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at
     FROM deposit_schedules
     WHERE id = $1 AND importer_id = $2`,
    [req.params.scheduleId, importer.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'deposit schedule not found' });
    return;
  }

  res.json({ schedule: r.rows[0]! });
});

// GET /importers/:id/deposit-schedule/:scheduleId/history — get history for specific schedule
importersRouter.get('/:id/deposit-schedule/:scheduleId/history', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, schedule_id, importer_id, amount_stroops::text AS amount_stroops,
            bucket, status, job_id, error_message, executed_at
     FROM deposit_schedule_executions
     WHERE schedule_id = $1 AND importer_id = $2
     ORDER BY executed_at DESC`,
    [req.params.scheduleId, importer.id]
  );

  res.json({ history: r.rows });
});

// POST /importers/:id/deposit-schedule/:scheduleId/pause — pause schedule
importersRouter.post('/:id/deposit-schedule/:scheduleId/pause', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `UPDATE deposit_schedules
     SET status = 'paused', updated_at = now()
     WHERE id = $1 AND importer_id = $2
     RETURNING id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
               bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at`,
    [req.params.scheduleId, importer.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'deposit schedule not found' });
    return;
  }

  await logAudit(user.id, 'pause_deposit_schedule', importer.id, {
    scheduleId: req.params.scheduleId,
  });

  res.json({ schedule: r.rows[0]! });
});

// POST /importers/:id/deposit-schedule/:scheduleId/resume — resume schedule
importersRouter.post('/:id/deposit-schedule/:scheduleId/resume', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const existing = await pool.query(
    `SELECT id, cadence, next_run_at FROM deposit_schedules WHERE id = $1 AND importer_id = $2`,
    [req.params.scheduleId, importer.id]
  );

  if (!existing.rowCount) {
    res.status(404).json({ error: 'deposit schedule not found' });
    return;
  }

  const current = existing.rows[0]!;
  let nextRunAt = current.next_run_at;
  if (new Date(nextRunAt).getTime() <= Date.now()) {
    nextRunAt = computeNextRunAt(current.cadence, new Date());
  }

  const r = await pool.query(
    `UPDATE deposit_schedules
     SET status = 'active', next_run_at = $3, updated_at = now()
     WHERE id = $1 AND importer_id = $2
     RETURNING id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
               bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at`,
    [req.params.scheduleId, importer.id, nextRunAt]
  );

  await logAudit(user.id, 'resume_deposit_schedule', importer.id, {
    scheduleId: req.params.scheduleId,
  });

  res.json({ schedule: r.rows[0]! });
});

// PATCH /importers/:id/deposit-schedule/:scheduleId — edit schedule
importersRouter.patch('/:id/deposit-schedule/:scheduleId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = UpdateDepositScheduleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const { cadence, amountStroops, bucket, status } = parse.data;
  if (!cadence && !amountStroops && !bucket && !status) {
    res.status(400).json({ error: 'no fields provided to update' });
    return;
  }

  const existing = await pool.query(
    `SELECT id, cadence, amount_stroops, bucket, status, next_run_at FROM deposit_schedules WHERE id = $1 AND importer_id = $2`,
    [req.params.scheduleId, importer.id]
  );

  if (!existing.rowCount) {
    res.status(404).json({ error: 'deposit schedule not found' });
    return;
  }

  const cur = existing.rows[0]!;
  const newCadence = cadence ?? cur.cadence;
  const newAmount = amountStroops ?? cur.amount_stroops;
  const newBucket = bucket ?? cur.bucket;
  const newStatus = status ?? cur.status;

  const r = await pool.query(
    `UPDATE deposit_schedules
     SET cadence = $3, amount_stroops = $4, bucket = $5, status = $6, updated_at = now()
     WHERE id = $1 AND importer_id = $2
     RETURNING id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
               bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at`,
    [req.params.scheduleId, importer.id, newCadence, newAmount, newBucket, newStatus]
  );

  await logAudit(user.id, 'update_deposit_schedule', importer.id, {
    scheduleId: req.params.scheduleId,
    changes: parse.data,
  });

  res.json({ schedule: r.rows[0]! });
});

// POST /importers/:id/deposit-schedule/:scheduleId/cancel & DELETE /importers/:id/deposit-schedule/:scheduleId — cancel schedule
async function handleCancelDepositSchedule(req: Request, res: Response): Promise<void> {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `UPDATE deposit_schedules
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND importer_id = $2
     RETURNING id, importer_id, user_id, cadence, amount_stroops::text AS amount_stroops,
               bucket, status, next_run_at, last_run_at, last_error, created_at, updated_at`,
    [req.params.scheduleId, importer.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'deposit schedule not found' });
    return;
  }

  await logAudit(user.id, 'cancel_deposit_schedule', importer.id, {
    scheduleId: req.params.scheduleId,
  });

  res.json({ success: true, schedule: r.rows[0]! });
}

importersRouter.post('/:id/deposit-schedule/:scheduleId/cancel', handleCancelDepositSchedule);
importersRouter.delete('/:id/deposit-schedule/:scheduleId', handleCancelDepositSchedule);

// ── #1038: Dual Sign-Off Approval Configuration & Withdrawal Workflow ───────

const DualApprovalConfigSchema = z.object({
  enabled: z.boolean(),
  thresholdStroops: z.string().regex(/^\d+$/),
  secondApproverId: z.string().uuid().nullable().optional(),
  secondApproverEmail: z.string().email().nullable().optional(),
});

importersRouter.get('/:id/dual-approval', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.json({
    enabled: Boolean(importer.dual_approval_enabled),
    thresholdStroops: String(importer.dual_approval_threshold_stroops ?? '0'),
    secondApproverId: importer.second_approver_id ?? null,
    secondApproverEmail: importer.second_approver_email ?? null,
  });
});

importersRouter.put('/:id/dual-approval', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (user.role !== 'surety_admin' && importer.user_id !== user.id) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const parse = DualApprovalConfigSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const { enabled, thresholdStroops, secondApproverId, secondApproverEmail } = parse.data;

  const result = await pool.query(
    `UPDATE importers
       SET dual_approval_enabled = $1,
           dual_approval_threshold_stroops = $2,
           second_approver_id = $3,
           second_approver_email = $4
     WHERE id = $5
     RETURNING id, dual_approval_enabled, dual_approval_threshold_stroops, second_approver_id, second_approver_email`,
    [enabled, thresholdStroops, secondApproverId ?? null, secondApproverEmail ?? null, importer.id]
  );

  await logAudit(user.id, 'dual_approval_configured', importer.id, {
    enabled,
    thresholdStroops,
    secondApproverId,
    secondApproverEmail,
  });

  res.json({
    enabled: Boolean(result.rows[0]?.dual_approval_enabled),
    thresholdStroops: String(result.rows[0]?.dual_approval_threshold_stroops ?? '0'),
    secondApproverId: result.rows[0]?.second_approver_id ?? null,
    secondApproverEmail: result.rows[0]?.second_approver_email ?? null,
  });
});

importersRouter.get('/:id/withdrawal-requests', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const requests = await pool.query(
    `SELECT wr.id, wr.importer_id, wr.requested_by, u.email AS requested_by_email,
            wr.amount_stroops, wr.status, wr.second_approver_id, sa.email AS second_approver_email,
            wr.approved_by, ap.email AS approved_by_email, wr.rejected_by, rj.email AS rejected_by_email,
            wr.rejection_reason, wr.job_id, wr.created_at, wr.resolved_at
       FROM withdrawal_requests wr
       LEFT JOIN users u ON u.id = wr.requested_by
       LEFT JOIN users sa ON sa.id = wr.second_approver_id
       LEFT JOIN users ap ON ap.id = wr.approved_by
       LEFT JOIN users rj ON rj.id = wr.rejected_by
      WHERE wr.importer_id = $1
      ORDER BY wr.created_at DESC`,
    [importer.id]
  );

  res.json({ requests: requests.rows });
});

importersRouter.post(
  '/:id/withdrawal-requests/:requestId/approve',
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const reqResult = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE id = $1 AND importer_id = $2',
      [req.params.requestId, importer.id]
    );
    const wr = reqResult.rows[0];
    if (!wr) {
      res.status(404).json({ error: 'withdrawal request not found' });
      return;
    }

    if (wr.status !== 'pending') {
      res.status(400).json({ error: `Cannot approve request with status: ${wr.status}` });
      return;
    }

    if (wr.requested_by === user.id && user.role !== 'surety_admin') {
      res.status(403).json({ error: 'requester cannot self-approve dual sign-off withdrawal' });
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
        amountStroops: wr.amount_stroops,
      },
    });

    await pool.query(
      `UPDATE withdrawal_requests
        SET status = 'approved',
            approved_by = $1,
            job_id = $2,
            resolved_at = now()
      WHERE id = $3`,
      [user.id, jobId, wr.id]
    );

    await logAudit(user.id, 'withdraw_approved', importer.id, {
      withdrawalRequestId: wr.id,
      amountStroops: wr.amount_stroops,
      jobId,
    });

    await invalidateOnChainAccount(importer.id);

    res.json({
      status: 'approved',
      jobId,
      statusUrl: `/importers/${importer.id}/tx-status/${jobId}`,
    });
  }
);

importersRouter.post(
  '/:id/withdrawal-requests/:requestId/reject',
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const reqResult = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE id = $1 AND importer_id = $2',
      [req.params.requestId, importer.id]
    );
    const wr = reqResult.rows[0];
    if (!wr) {
      res.status(404).json({ error: 'withdrawal request not found' });
      return;
    }

    if (wr.status !== 'pending') {
      res.status(400).json({ error: `Cannot reject request with status: ${wr.status}` });
      return;
    }

    const reason = req.body?.reason ? String(req.body.reason) : null;

    await pool.query(
      `UPDATE withdrawal_requests
        SET status = 'rejected',
            rejected_by = $1,
            rejection_reason = $2,
            resolved_at = now()
      WHERE id = $3`,
      [user.id, reason, wr.id]
    );

    await logAudit(user.id, 'withdraw_rejected', importer.id, {
      withdrawalRequestId: wr.id,
      amountStroops: wr.amount_stroops,
      reason,
    });

    res.json({ status: 'rejected' });
  }
);

importersRouter.post(
  '/:id/withdrawal-requests/:requestId/cancel',
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const reqResult = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE id = $1 AND importer_id = $2',
      [req.params.requestId, importer.id]
    );
    const wr = reqResult.rows[0];
    if (!wr) {
      res.status(404).json({ error: 'withdrawal request not found' });
      return;
    }

    if (wr.status !== 'pending') {
      res.status(400).json({ error: `Cannot cancel request with status: ${wr.status}` });
      return;
    }

    if (wr.requested_by !== user.id && user.role !== 'surety_admin') {
      res
        .status(403)
        .json({ error: 'Only the original requester can cancel a pending withdrawal' });
      return;
    }

    await pool.query(
      `UPDATE withdrawal_requests
        SET status = 'cancelled',
            resolved_at = now()
      WHERE id = $1`,
      [wr.id]
    );

    await logAudit(user.id, 'withdraw_cancelled', importer.id, {
      withdrawalRequestId: wr.id,
      amountStroops: wr.amount_stroops,
    });

    res.json({ status: 'cancelled' });
  }
);

const WithdrawSchema = z.object({
  amountStroops: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, {
      message: 'amountStroops must be a positive integer',
    }),
  targetDate: z.string().optional(),
  targetAddress: z.string().optional(),
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
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Transaction blocked pending AML review' });
    return;
  }

  // Future-dated scheduled withdrawal support (#994)
  if (parse.data.targetDate) {
    const targetDate = new Date(parse.data.targetDate);
    if (isNaN(targetDate.getTime()) || targetDate.getTime() <= Date.now()) {
      res.status(400).json({ error: 'targetDate must be a valid future timestamp' });
      return;
    }

    const inserted = await pool.query(
      `INSERT INTO scheduled_withdrawals (importer_id, requested_by, amount_stroops, target_date, target_address, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
                 target_date, target_address, status, created_at, updated_at`,
      [importer.id, user.id, parse.data.amountStroops, targetDate, parse.data.targetAddress ?? null]
    );

    const scheduledWithdrawal = inserted.rows[0]!;
    await logAudit(user.id, 'withdraw_scheduled', importer.id, {
      withdrawalId: scheduledWithdrawal.id,
      amountStroops: parse.data.amountStroops,
      targetDate: targetDate.toISOString(),
    });

    res.status(201).json({ status: 'scheduled', scheduledWithdrawal });
    return;
  }

  // Dual sign-off threshold check (#1038)
  const dualEnabled = Boolean(importer.dual_approval_enabled);
  const threshold = BigInt(importer.dual_approval_threshold_stroops ?? '0');
  const amountStroops = BigInt(parse.data.amountStroops);

  if (dualEnabled && threshold > 0n && amountStroops >= threshold) {
    const reqInsert = await pool.query(
      `INSERT INTO withdrawal_requests (importer_id, requested_by, amount_stroops, status, second_approver_id)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, importer_id, requested_by, amount_stroops, status, second_approver_id, created_at`,
      [importer.id, user.id, parse.data.amountStroops, importer.second_approver_id ?? null]
    );
    const requestRow = reqInsert.rows[0]!;
    await logAudit(user.id, 'withdraw_requested_pending_approval', importer.id, {
      amountStroops: parse.data.amountStroops,
      withdrawalRequestId: requestRow.id,
    });
    res.status(202).json({
      status: 'pending_approval',
      withdrawalRequestId: requestRow.id,
      amountStroops: parse.data.amountStroops,
      message: 'Withdrawal amount exceeds dual sign-off threshold and requires second approval.',
    });
    return;
  }

  const jobId = await enqueueTxSubmit({
    method: 'withdraw',
    importerId: importer.id,
    keypairSecret: importer.stellar_secret_encrypted,
    args: {
      importerAddress: importer.stellar_address,
      sourceAddress: parse.data.targetAddress || importer.stellar_address,
      amountStroops: parse.data.amountStroops,
    },
  });
  await logAudit(user.id, 'withdraw', importer.id, { amountStroops: parse.data.amountStroops });

  // #246 — see the matching comment in POST /:id/deposit above: this covers
  // the pre-confirmation window, the queue worker invalidates again on completion.
  await invalidateOnChainAccount(importer.id);

  res.status(202).json({ jobId, statusUrl: `/importers/${importer.id}/tx-status/${jobId}` });
});

// ── #994: Future-Dated Staged Withdrawal Scheduling for Collateral ───────────

const CreateScheduledWithdrawalSchema = z.object({
  amountStroops: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, {
      message: 'amountStroops must be a positive integer',
    }),
  targetDate: z.string(),
  targetAddress: z.string().optional(),
});

// POST /importers/:id/scheduled-withdrawals — schedule future-dated withdrawal
importersRouter.post('/:id/scheduled-withdrawals', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (importer.kyc_status !== 'approved') {
    res.status(403).json({
      error: 'KYC approval required before withdrawals',
      kycStatus: importer.kyc_status,
    });
    return;
  }

  const parse = CreateScheduledWithdrawalSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const targetDate = new Date(parse.data.targetDate);
  if (isNaN(targetDate.getTime()) || targetDate.getTime() <= Date.now()) {
    res.status(400).json({ error: 'targetDate must be a valid future timestamp' });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === 'HIGH') {
    res.status(403).json({ error: 'Transaction blocked pending AML review' });
    return;
  }

  const inserted = await pool.query(
    `INSERT INTO scheduled_withdrawals (importer_id, requested_by, amount_stroops, target_date, target_address, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
               target_date, target_address, status, created_at, updated_at`,
    [importer.id, user.id, parse.data.amountStroops, targetDate, parse.data.targetAddress ?? null]
  );

  const scheduledWithdrawal = inserted.rows[0]!;
  await logAudit(user.id, 'withdraw_scheduled', importer.id, {
    withdrawalId: scheduledWithdrawal.id,
    amountStroops: parse.data.amountStroops,
    targetDate: targetDate.toISOString(),
  });

  res.status(201).json({ scheduledWithdrawal });
});

// GET /importers/:id/scheduled-withdrawals — list scheduled withdrawals
importersRouter.get('/:id/scheduled-withdrawals', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
            target_date, target_address, status, execution_result, executed_at, job_id, created_at, updated_at
     FROM scheduled_withdrawals
     WHERE importer_id = $1
     ORDER BY target_date ASC`,
    [importer.id]
  );

  res.json({ scheduledWithdrawals: r.rows });
});

// GET /importers/:id/scheduled-withdrawals/:withdrawalId — get single scheduled withdrawal
importersRouter.get('/:id/scheduled-withdrawals/:withdrawalId', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const r = await pool.query(
    `SELECT id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
            target_date, target_address, status, execution_result, executed_at, job_id, created_at, updated_at
     FROM scheduled_withdrawals
     WHERE id = $1 AND importer_id = $2`,
    [req.params.withdrawalId, importer.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'scheduled withdrawal not found' });
    return;
  }

  res.json({ scheduledWithdrawal: r.rows[0]! });
});

// POST /importers/:id/scheduled-withdrawals/:withdrawalId/cancel & DELETE /importers/:id/scheduled-withdrawals/:withdrawalId — cancel pending scheduled withdrawal
async function handleCancelScheduledWithdrawal(req: Request, res: Response): Promise<void> {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const existing = await pool.query(
    `SELECT id, status, target_date FROM scheduled_withdrawals WHERE id = $1 AND importer_id = $2`,
    [req.params.withdrawalId, importer.id]
  );

  if (!existing.rowCount) {
    res.status(404).json({ error: 'scheduled withdrawal not found' });
    return;
  }

  const sw = existing.rows[0]!;
  if (sw.status !== 'pending') {
    res.status(409).json({ error: `cannot cancel withdrawal with status ${sw.status}` });
    return;
  }

  if (new Date(sw.target_date).getTime() <= Date.now()) {
    res.status(400).json({ error: 'cannot cancel a scheduled withdrawal that has reached its target execution date' });
    return;
  }

  const r = await pool.query(
    `UPDATE scheduled_withdrawals
     SET status = 'cancelled', execution_result = 'Cancelled by user', updated_at = now()
     WHERE id = $1 AND importer_id = $2
     RETURNING id, importer_id, requested_by, amount_stroops::text AS amount_stroops,
               target_date, target_address, status, execution_result, executed_at, job_id, created_at, updated_at`,
    [req.params.withdrawalId, importer.id]
  );

  await logAudit(user.id, 'withdraw_scheduled_cancelled', importer.id, {
    withdrawalId: req.params.withdrawalId,
  });

  res.json({ success: true, scheduledWithdrawal: r.rows[0]! });
}

importersRouter.post('/:id/scheduled-withdrawals/:withdrawalId/cancel', handleCancelScheduledWithdrawal);
importersRouter.delete('/:id/scheduled-withdrawals/:withdrawalId', handleCancelScheduledWithdrawal);

// ── #1040: Bulk HS Code Mapping Table Import for Product Catalogs ───────────

const SkuMappingItemSchema = z.object({
  sku: z.string().min(1),
  htsCode: z.string().min(1),
  description: z.string().optional(),
  dutyRate: z.coerce.number().min(0).optional(),
});

const BulkSkuMappingSchema = z.object({
  mappings: z.array(SkuMappingItemSchema).optional(),
  csvText: z.string().optional(),
});

importersRouter.post('/:id/sku-mappings/bulk', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = BulkSkuMappingSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  let items: Array<{ sku: string; htsCode: string; description?: string; dutyRate?: number }> = [];

  if (parse.data.mappings && parse.data.mappings.length > 0) {
    items = parse.data.mappings;
  } else if (parse.data.csvText) {
    const lines = parse.data.csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      const firstLine = lines[0]!.toLowerCase();
      const hasHeader = firstLine.includes('sku') || firstLine.includes('hts');
      const dataLines = hasHeader ? lines.slice(1) : lines;

      for (const line of dataLines) {
        const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
        if (parts.length >= 2 && parts[0] && parts[1]) {
          const sku = parts[0];
          const htsCode = parts[1];
          const description = parts[2] || undefined;
          const dutyRate = parts[3] && !isNaN(Number(parts[3])) ? Number(parts[3]) : undefined;
          items.push({ sku, htsCode, description, dutyRate });
        }
      }
    }
  }

  if (items.length === 0) {
    res.status(400).json({ error: 'no valid SKU mapping entries found in payload' });
    return;
  }

  const vRes = await pool.query<{ max_version: number | null }>(
    'SELECT MAX(version) AS max_version FROM importer_sku_mappings WHERE importer_id = $1',
    [importer.id]
  );
  const nextVersion = (vRes.rows[0]?.max_version ?? 0) + 1;

  await pool.query('UPDATE importer_sku_mappings SET is_active = false WHERE importer_id = $1', [
    importer.id,
  ]);

  for (const it of items) {
    await pool.query(
      `INSERT INTO importer_sku_mappings (importer_id, version, sku, hts_code, description, duty_rate, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (importer_id, version, sku) DO UPDATE
         SET hts_code = EXCLUDED.hts_code,
             description = EXCLUDED.description,
             duty_rate = EXCLUDED.duty_rate,
             updated_at = now()`,
      [importer.id, nextVersion, it.sku, it.htsCode, it.description ?? null, it.dutyRate ?? null]
    );
  }

  await logAudit(user.id, 'sku_mappings_imported', importer.id, {
    version: nextVersion,
    count: items.length,
  });

  res.status(201).json({
    success: true,
    version: nextVersion,
    count: items.length,
  });
});

importersRouter.get('/:id/sku-mappings', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const { search, version, page = '1', per_page = '50' } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(per_page, 10) || 50));
  const offset = (pageNum - 1) * limit;

  const conditions = ['importer_id = $1'];
  const params: unknown[] = [importer.id];

  if (version) {
    params.push(parseInt(version, 10));
    conditions.push(`version = $${params.length}`);
  } else {
    conditions.push('is_active = true');
  }

  if (search && search.trim().length > 0) {
    params.push(`%${search.trim()}%`);
    conditions.push(
      `(sku ILIKE $${params.length} OR hts_code ILIKE $${params.length} OR description ILIKE $${params.length})`
    );
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM importer_sku_mappings ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  params.push(limit, offset);
  const rows = await pool.query(
    `SELECT id, importer_id, version, sku, hts_code, description, duty_rate, is_active, created_at, updated_at
       FROM importer_sku_mappings
       ${where}
       ORDER BY sku ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    mappings: rows.rows,
    pagination: {
      total,
      page: pageNum,
      per_page: limit,
      total_pages: Math.ceil(total / limit),
    },
  });
});

importersRouter.post('/:id/sku-mappings', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = SkuMappingItemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const { sku, htsCode, description, dutyRate } = parse.data;

  const vRes = await pool.query<{ version: number | null }>(
    'SELECT version FROM importer_sku_mappings WHERE importer_id = $1 AND is_active = true LIMIT 1',
    [importer.id]
  );
  const currentVersion = vRes.rows[0]?.version ?? 1;

  const result = await pool.query(
    `INSERT INTO importer_sku_mappings (importer_id, version, sku, hts_code, description, duty_rate, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (importer_id, version, sku) DO UPDATE
       SET hts_code = EXCLUDED.hts_code,
           description = EXCLUDED.description,
           duty_rate = EXCLUDED.duty_rate,
           is_active = true,
           updated_at = now()
     RETURNING id, importer_id, version, sku, hts_code, description, duty_rate, is_active, created_at, updated_at`,
    [importer.id, currentVersion, sku, htsCode, description ?? null, dutyRate ?? null]
  );

  await logAudit(user.id, 'sku_mapping_created', importer.id, { sku, htsCode });

  res.status(201).json({ mapping: result.rows[0] });
});

importersRouter.put('/:id/sku-mappings/:mappingId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = SkuMappingItemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const { sku, htsCode, description, dutyRate } = parse.data;

  const result = await pool.query(
    `UPDATE importer_sku_mappings
        SET sku = $1,
            hts_code = $2,
            description = $3,
            duty_rate = $4,
            updated_at = now()
      WHERE id = $5 AND importer_id = $6
      RETURNING id, importer_id, version, sku, hts_code, description, duty_rate, is_active, created_at, updated_at`,
    [sku, htsCode, description ?? null, dutyRate ?? null, req.params.mappingId, importer.id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'mapping entry not found' });
    return;
  }

  await logAudit(user.id, 'sku_mapping_updated', importer.id, {
    mappingId: req.params.mappingId,
    sku,
    htsCode,
  });

  res.json({ mapping: result.rows[0] });
});

importersRouter.delete('/:id/sku-mappings/:mappingId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const result = await pool.query(
    'DELETE FROM importer_sku_mappings WHERE id = $1 AND importer_id = $2 RETURNING id, sku',
    [req.params.mappingId, importer.id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'mapping entry not found' });
    return;
  }

  await logAudit(user.id, 'sku_mapping_deleted', importer.id, {
    mappingId: req.params.mappingId,
    sku: result.rows[0]?.sku,
  });

  res.json({ success: true });
});

// ── #1041: Consolidated Document Expiration Calendar View ────────────────────

export interface ComplianceExpirationItem {
  id: string;
  entityType: 'kyc' | 'surety_license';
  title: string;
  documentType: string;
  expirationDate: string;
  daysUntilExpiration: number;
  urgency: 'critical' | 'warning' | 'upcoming' | 'normal';
  deepLink: string;
  metadata?: Record<string, unknown>;
}

importersRouter.get('/:id/compliance-calendar', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const items: ComplianceExpirationItem[] = [];
  const now = Date.now();

  const kycDocs = await pool.query(
    `SELECT id, document_type, document_name, upload_timestamp, expiration_date, scheduled_deletion_date, review_status
       FROM kyc_documents
      WHERE importer_id = $1 AND deleted_at IS NULL`,
    [importer.id]
  );

  for (const doc of kycDocs.rows) {
    const expiry = doc.expiration_date
      ? new Date(doc.expiration_date)
      : doc.upload_timestamp
        ? new Date(new Date(doc.upload_timestamp).getTime() + 365 * 24 * 60 * 60 * 1000)
        : null;

    if (expiry) {
      const daysUntil = Math.ceil((expiry.getTime() - now) / (1000 * 60 * 60 * 24));
      let urgency: 'critical' | 'warning' | 'upcoming' | 'normal' = 'normal';
      if (daysUntil <= 30) urgency = 'critical';
      else if (daysUntil <= 60) urgency = 'warning';
      else if (daysUntil <= 90) urgency = 'upcoming';

      const docName = doc.document_name || doc.document_type.replace(/_/g, ' ').toUpperCase();
      items.push({
        id: doc.id,
        entityType: 'kyc',
        title: `KYC: ${docName}`,
        documentType: doc.document_type,
        expirationDate: expiry.toISOString(),
        daysUntilExpiration: daysUntil,
        urgency,
        deepLink: `/app?tab=kyc`,
        metadata: { reviewStatus: doc.review_status },
      });
    }
  }

  const suretyLicenses = await pool.query(
    'SELECT id, state_code, license_number, expiration_date, status, renewal_url FROM surety_state_licenses'
  );

  for (const lic of suretyLicenses.rows) {
    if (lic.expiration_date) {
      const expiry = new Date(lic.expiration_date);
      const daysUntil = Math.ceil((expiry.getTime() - now) / (1000 * 60 * 60 * 24));
      let urgency: 'critical' | 'warning' | 'upcoming' | 'normal' = 'normal';
      if (daysUntil <= 30) urgency = 'critical';
      else if (daysUntil <= 60) urgency = 'warning';
      else if (daysUntil <= 90) urgency = 'upcoming';

      items.push({
        id: lic.id,
        entityType: 'surety_license',
        title: `Surety License (${lic.state_code}): ${lic.license_number}`,
        documentType: 'surety_state_license',
        expirationDate: expiry.toISOString(),
        daysUntilExpiration: daysUntil,
        urgency,
        deepLink: lic.renewal_url || '/surety-license/submit',
        metadata: { status: lic.status, stateCode: lic.state_code },
      });
    }
  }

  items.sort((a, b) => new Date(a.expirationDate).getTime() - new Date(b.expirationDate).getTime());

  res.json({ items });
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
      res.status(400).json({ error: 'invalid input', target: 'body' });
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
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
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
// other document flows already do.

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
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
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

// ── #1028: Multi-bond portfolio view ──────────────────────────────────────

importersRouter.get('/:id/portfolio', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Get all bonds for this importer
  const bondsResult = await pool.query(
    `SELECT id, bond_number, policy_type, coverage_amount, status,
            issued_at, expires_at, replaced_by_id, stellar_contract_address, created_at
       FROM bonds WHERE importer_id = $1 ORDER BY created_at DESC`,
    [importer.id]
  );

  const bonds = bondsResult.rows;
  
  // Aggregate totals
  const totalCoverage = bonds.reduce((sum, bond) => sum + Number(bond.coverage_amount || 0), 0);
  const activeBonds = bonds.filter(bond => bond.status === 'active');
  const totalActiveCoverage = activeBonds.reduce((sum, bond) => sum + Number(bond.coverage_amount || 0), 0);
  
  // Upcoming renewals (within 90 days)
  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const upcomingRenewals = bonds.filter(bond => {
    if (!bond.expires_at) return false;
    const expiresAt = new Date(bond.expires_at);
    return expiresAt >= now && expiresAt <= ninetyDaysFromNow;
  });

  // Get collateral status from on-chain
  let collateralStatus;
  try {
    const acct = await contractClient.getAccount(importer.stellar_address);
    collateralStatus = {
      collateralBalance: acct.collateralBalance.toString(),
      requiredCollateral: acct.requiredCollateral.toString(),
      reserveBalance: acct.reserveBalance.toString(),
      yieldAccrued: acct.yieldAccrued.toString(),
    };
  } catch (err) {
    collateralStatus = null;
  }

  // Sort options
  const sortBy = String(req.query.sort_by || 'created_at');
  const sortOrder = String(req.query.sort_order || 'desc');
  
  let sortedBonds = [...bonds];
  if (sortBy === 'expires_at') {
    sortedBonds.sort((a, b) => {
      const dateA = a.expires_at ? new Date(a.expires_at).getTime() : 0;
      const dateB = b.expires_at ? new Date(b.expires_at).getTime() : 0;
      return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
    });
  } else if (sortBy === 'coverage_amount') {
    sortedBonds.sort((a, b) => {
      const amountA = Number(a.coverage_amount || 0);
      const amountB = Number(b.coverage_amount || 0);
      return sortOrder === 'asc' ? amountA - amountB : amountB - amountA;
    });
  } else if (sortBy === 'status') {
    sortedBonds.sort((a, b) => {
      const statusOrder = { active: 0, pending: 1, expired: 2, replaced: 3 };
      const orderA = statusOrder[a.status as keyof typeof statusOrder] ?? 4;
      const orderB = statusOrder[b.status as keyof typeof statusOrder] ?? 4;
      return sortOrder === 'asc' ? orderA - orderB : orderB - orderA;
    });
  }

  // Filter by status if provided
  const statusFilter = String(req.query.status || '');
  if (statusFilter) {
    sortedBonds = sortedBonds.filter(bond => bond.status === statusFilter);
  }

  res.json({
    importer: {
      id: importer.id,
      legalName: importer.legal_name,
      bondId: importer.bond_id,
    },
    portfolio: {
      totalBonds: bonds.length,
      activeBonds: activeBonds.length,
      totalCoverage,
      totalActiveCoverage,
      upcomingRenewalsCount: upcomingRenewals.length,
      upcomingRenewals: upcomingRenewals.map(bond => ({
        id: bond.id,
        bondNumber: bond.bond_number,
        expiresAt: bond.expires_at,
        coverageAmount: bond.coverage_amount,
      })),
    },
    collateralStatus,
    bonds: sortedBonds,
  });
});

// ── #1030: Tariff exposure forecasting ────────────────────────────────────

importersRouter.get('/:id/forecast', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Get historical tariff uploads
  const uploadsResult = await pool.query(
    `SELECT id, annual_duty_total, computed_required_collateral, created_at
       FROM tariff_uploads
       WHERE importer_id = $1
       ORDER BY created_at ASC`,
    [importer.id]
  );

  const uploads = uploadsResult.rows;
  
  if (uploads.length < 2) {
    res.json({
      forecast: null,
      message: 'Insufficient upload history for forecasting (need at least 2 uploads)',
      historicalData: uploads.map(u => ({
        date: u.created_at,
        annualDutyTotal: u.annual_duty_total,
        requiredCollateral: u.computed_required_collateral,
      })),
    });
    return;
  }

  // Calculate linear trend
  const n = uploads.length;
  const xValues = uploads.map((_, i) => i);
  const yValues = uploads.map(u => Number(u.annual_duty_total));
  
  const sumX = xValues.reduce((a, b) => a + b, 0);
  const sumY = yValues.reduce((a, b) => a + b, 0);
  const sumXY = xValues.reduce((sum, x, i) => sum + x * (yValues[i] ?? 0), 0);
  const sumX2 = xValues.reduce((sum, x) => sum + x * x, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Project 30, 60, 90 days out (assuming monthly uploads)
  const lastX = n - 1;
  const firstUpload = uploads[0];
  const lastUpload = uploads[n - 1];
  const monthsPerUpload = uploads.length > 1 && firstUpload && lastUpload ? 
    (new Date(lastUpload.created_at).getTime() - new Date(firstUpload.created_at).getTime()) / (n - 1) / (30 * 24 * 60 * 60 * 1000) : 1;
  
  const forecastPoints = [30, 60, 90].map(days => {
    const monthsOut = days / 30;
    const futureX = lastX + monthsOut / monthsPerUpload;
    const projectedDuty = slope * futureX + intercept;
    const projectedCollateral = projectedDuty * 0.1 * 0.5; // Same formula as upload handler
    return {
      daysOut: days,
      projectedAnnualDutyTotal: Math.max(0, projectedDuty),
      projectedRequiredCollateral: Math.max(0, projectedCollateral),
      isProjection: true,
    };
  });

  // Historical data for chart
  const historicalData = uploads.map(u => ({
    date: u.created_at,
    annualDutyTotal: Number(u.annual_duty_total),
    requiredCollateral: Number(u.computed_required_collateral),
    isProjection: false,
  }));

  res.json({
    forecast: {
      trend: slope > 0 ? 'increasing' : slope < 0 ? 'decreasing' : 'stable',
      slope,
      intercept,
      projections: forecastPoints,
    },
    historicalData,
    disclaimer: 'This forecast is a non-binding projection based on historical trends and should not be used as financial advice.',
  });
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

// ── #1019: Historical Tariff Rate Trend Endpoints ────────────────────────────

const TariffHistoryQuerySchema = z.object({
  htsCode: z.string().min(4).max(14),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// GET /importers/:id/tariff-history — read-only historical duty rate trend for HTS code
importersRouter.get('/:id/tariff-history', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const parse = TariffHistoryQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
    return;
  }
  const { htsCode, startDate, endDate } = parse.data;

  try {
    // Get importer's latest CSV upload timestamp
    const latestUploadRes = await pool.query(
      `SELECT created_at FROM importer_tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [importer.id]
    );
    const latestUploadDate = latestUploadRes.rows[0]?.created_at || null;

    // Build query for hts_rate_history
    const conditions: string[] = ['hts_code = $1'];
    const params: any[] = [htsCode];

    if (startDate) {
      params.push(startDate);
      conditions.push(`effective_date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      conditions.push(`effective_date <= $${params.length}`);
    }

    const historyRes = await pool.query(
      `SELECT hts_code, duty_rate::float AS duty_rate, effective_date, source, created_at
       FROM hts_rate_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY effective_date ASC`,
      params
    );

    res.json({
      htsCode,
      latestUploadDate,
      history: historyRes.rows.map((r) => ({
        date: r.effective_date,
        dutyRate: r.duty_rate,
        source: r.source,
      })),
    });
  } catch (err: any) {
    console.error('[importers] failed to query tariff rate history:', err);
    res.status(500).json({ error: 'failed to retrieve tariff history' });
  }
});

// ── Webhook Subscriptions Management (#1023) ─────────────────────────────────

const WebhookSubscriptionSchema = z.object({
  targetUrl: z.string().url(),
  eventTypes: z.array(z.enum(['deposit', 'top_up', 'clawback', 'all'])).min(1),
});

// POST /importers/:id/webhooks — Register new webhook subscription
importersRouter.post('/:id/webhooks', async (req: Request, res: Response) => {
  const importerId = String(req.params.id ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const parse = WebhookSubscriptionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }

  const { targetUrl, eventTypes } = parse.data;
  const secretKey = `whsec_${createHash('sha256').update(`${importerId}-${Date.now()}-${Math.random()}`).digest('hex').substring(0, 32)}`;

  try {
    const result = await pool.query(
      `INSERT INTO webhook_subscriptions (importer_id, target_url, event_types, secret_key)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, importer_id, target_url, event_types, secret_key, is_active, created_at`,
      [importerId, targetUrl, JSON.stringify(eventTypes), secretKey]
    );

    const user = (req as AuthedRequest).user;
    await logAudit(user.id, 'webhook_subscription_created', importerId, {
      subscriptionId: result.rows[0].id,
      targetUrl,
    });

    res.status(201).json({ subscription: result.rows[0] });
  } catch (err: any) {
    console.error('[importers] failed to create webhook subscription:', err);
    res.status(500).json({ error: 'failed to create webhook subscription' });
  }
});

// GET /importers/:id/webhooks — List webhook subscriptions
importersRouter.get('/:id/webhooks', async (req: Request, res: Response) => {
  const importerId = String(req.params.id ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, target_url, event_types, is_active, created_at
       FROM webhook_subscriptions
       WHERE importer_id = $1
       ORDER BY created_at DESC`,
      [importerId]
    );

    res.json({ subscriptions: result.rows });
  } catch (err: any) {
    console.error('[importers] failed to list webhook subscriptions:', err);
    res.status(500).json({ error: 'failed to list webhook subscriptions' });
  }
});

// DELETE /importers/:id/webhooks/:subId — Delete webhook subscription
importersRouter.delete('/:id/webhooks/:subId', async (req: Request, res: Response) => {
  const importerId = String(req.params.id ?? '');
  const subId = String(req.params.subId ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  try {
    const result = await pool.query(
      `DELETE FROM webhook_subscriptions
       WHERE id = $1 AND importer_id = $2
       RETURNING id`,
      [subId, importerId]
    );

    if (!result.rowCount) {
      res.status(404).json({ error: 'webhook subscription not found' });
      return;
    }

    const user = (req as AuthedRequest).user;
    await logAudit(user.id, 'webhook_subscription_deleted', importerId, { subId });

    res.json({ success: true });
  } catch (err: any) {
    console.error('[importers] failed to delete webhook subscription:', err);
    res.status(500).json({ error: 'failed to delete webhook subscription' });
  }
});

// GET /importers/:id/webhooks/:subId/logs — Delivery history log
importersRouter.get('/:id/webhooks/:subId/logs', async (req: Request, res: Response) => {
  const importerId = String(req.params.id ?? '');
  const subId = String(req.params.subId ?? '');
  const importer = await loadImporterFor(req, importerId);
  if (!importer) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, event_type, payload, status_code, response_body, attempt_count, status, created_at
       FROM webhook_delivery_logs
       WHERE subscription_id = $1 AND importer_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [subId, importerId]
    );

    res.json({ logs: result.rows });
  } catch (err: any) {
    console.error('[importers] failed to query webhook delivery logs:', err);
    res.status(500).json({ error: 'failed to query delivery logs' });
  }
});

export async function dispatchWebhookEvent(importerId: string, eventType: string, payload: Record<string, unknown>) {
  try {
    const subs = await pool.query(
      `SELECT id, target_url, secret_key, event_types
       FROM webhook_subscriptions
       WHERE importer_id = $1 AND is_active = TRUE`,
      [importerId]
    );

    for (const sub of subs.rows) {
      const eventTypes: string[] = sub.event_types;
      if (!eventTypes.includes('all') && !eventTypes.includes(eventType)) {
        continue;
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const serializedPayload = JSON.stringify({ event: eventType, timestamp, data: payload });
      const signature = createHash('sha256')
        .update(`${timestamp}.${serializedPayload}.${sub.secret_key}`)
        .digest('hex');

      executeWebhookDeliveryWithBackoff(sub.id, importerId, eventType, sub.target_url, serializedPayload, signature, 1);
    }
  } catch (err: any) {
    console.error('[importers] failed to dispatch webhook event:', err);
  }
}

async function executeWebhookDeliveryWithBackoff(
  subscriptionId: string,
  importerId: string,
  eventType: string,
  targetUrl: string,
  body: string,
  signature: string,
  attempt: number
) {
  const maxAttempts = 5;
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TariffShield-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });

    const respText = await response.text().catch(() => '');
    const isSuccess = response.ok;

    await pool.query(
      `INSERT INTO webhook_delivery_logs (subscription_id, importer_id, event_type, payload, status_code, response_body, attempt_count, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        subscriptionId,
        importerId,
        eventType,
        body,
        response.status,
        respText.substring(0, 1000),
        attempt,
        isSuccess ? 'delivered' : attempt >= maxAttempts ? 'failed' : 'pending',
      ]
    );

    if (!isSuccess && attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      setTimeout(() => {
        executeWebhookDeliveryWithBackoff(subscriptionId, importerId, eventType, targetUrl, body, signature, attempt + 1);
      }, backoffMs);
    }
  } catch (err: any) {
    await pool.query(
      `INSERT INTO webhook_delivery_logs (subscription_id, importer_id, event_type, payload, status_code, response_body, attempt_count, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        subscriptionId,
        importerId,
        eventType,
        body,
        500,
        err.message || 'Network error',
        attempt,
        attempt >= maxAttempts ? 'failed' : 'pending',
      ]
    );

    if (attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      setTimeout(() => {
        executeWebhookDeliveryWithBackoff(subscriptionId, importerId, eventType, targetUrl, body, signature, attempt + 1);
      }, backoffMs);
    }
  }
}


