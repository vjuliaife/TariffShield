import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool, getStaleAccounts, refreshImporterMetricsView, logAudit, createNotification } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { platformKeypair, oracleKeypair, contractClient, explorerTx } from '../stellar.js';
import { bustHtsCache } from '../services/hts-rate-validator.js';
import { buildDisputeRecommendation } from '../services/dispute-recommendation.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { s3KeyDecrypt, generatePresignedUrl } from './kyc.js';

export const adminRouter = Router();
adminRouter.use(authMiddleware);
adminRouter.use(privacyReacceptanceGate);
adminRouter.use(tosReacceptanceGate);

// ── #231: GET /admin/audit-log ──────────────────────────────────────────────

const AuditLogQuerySchema = z.object({
  actor_user_id: z.string().uuid().optional(),
  action: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().optional(),
  format: z.enum(['json', 'csv']).optional(),
  export: z.enum(['json', 'csv']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(1000).default(50),
});

adminRouter.get('/audit-log', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const parse = AuditLogQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
    return;
  }
  const {
    actor_user_id,
    action,
    from,
    to,
    search,
    format,
    export: exportParam,
    page,
    per_page,
  } = parse.data;
  const isCsv = format === 'csv' || exportParam === 'csv' || req.headers.accept === 'text/csv';
  const offset = (page - 1) * per_page;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (actor_user_id) {
    params.push(actor_user_id);
    conditions.push(`al.actor_user_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    conditions.push(`al.action = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`al.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`al.created_at <= $${params.length}`);
  }
  if (search && search.trim().length > 0) {
    params.push(`%${search.trim()}%`);
    conditions.push(
      `(al.action ILIKE $${params.length} OR al.payload::text ILIKE $${params.length} OR u.email ILIKE $${params.length} OR al.target_id::text ILIKE $${params.length})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  if (isCsv) {
    // Export all matching rows for CSV
    const csvResult = await pool.query(
      `SELECT al.id, al.actor_user_id, u.email AS actor_email, al.action, al.target_id, al.payload, al.created_at
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT 5000`,
      params
    );

    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const header = [
      'id',
      'timestamp',
      'actor_email',
      'actor_user_id',
      'action',
      'target_id',
      'payload',
    ];
    const rows = csvResult.rows.map((row) =>
      [
        escapeCsv(row.id),
        escapeCsv((row.created_at as Date).toISOString()),
        escapeCsv(row.actor_email),
        escapeCsv(row.actor_user_id),
        escapeCsv(row.action),
        escapeCsv(row.target_id),
        escapeCsv(row.payload),
      ].join(',')
    );

    const csvContent = [header.join(','), ...rows].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log-export.csv"');
    res.status(200).send(csvContent);
    return;
  }

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  params.push(per_page, offset);
  const dataResult = await pool.query(
    `SELECT al.id, al.actor_user_id, u.email AS actor_email, al.action, al.target_id, al.payload, al.created_at
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    data: dataResult.rows.map((row) => ({
      ...row,
      created_at: (row.created_at as Date).toISOString(),
    })),
    pagination: {
      total,
      page,
      per_page,
      total_pages: Math.ceil(total / per_page),
    },
  });
});

adminRouter.get('/oracle-alerts', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const r = await pool.query(
    'SELECT * FROM oracle_alerts ORDER BY alerted_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );

  const countR = await pool.query('SELECT COUNT(*) FROM oracle_alerts');
  const total = parseInt(countR.rows[0]?.count || '0');

  res.json({
    alerts: r.rows,
    total,
    limit,
    offset,
  });
});

adminRouter.patch('/oracle-alerts/:id/acknowledge', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }

  const alertId = req.params.id;
  const r = await pool.query(
    'UPDATE oracle_alerts SET acknowledged_at = now() WHERE id = $1 RETURNING *',
    [alertId]
  );

  if (r.rowCount === 0) {
    res.status(404).json({ error: 'alert not found' });
    return;
  }

  res.json({ alert: r.rows[0] });
});

// #339 — GET /admin/roles — operational visibility into current role addresses
adminRouter.get('/roles', requireRole('surety_admin'), (_req: Request, res: Response) => {
  res.json({
    generalAdmin: platformKeypair.publicKey(),
    oracleAdmin: oracleKeypair.publicKey(),
    rolesAreDistinct: platformKeypair.publicKey() !== oracleKeypair.publicKey(),
  });
});

// #322 — POST /admin/privacy-policy/publish — publish a new privacy policy version
adminRouter.post(
  '/privacy-policy/publish',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const parse = z
      .object({
        versionId: z.string().min(1),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        changeSummary: z.string().min(10),
        policyText: z.string().optional(),
        requiresReacceptance: z.boolean().default(false),
      })
      .safeParse(req.body);

    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
      return;
    }
    const { versionId, effectiveDate, changeSummary, policyText, requiresReacceptance } =
      parse.data;

    const result = await pool.query(
      `INSERT INTO privacy_policy_versions
         (version_id, effective_date, policy_text, change_summary, requires_reacceptance, published_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, version_id, effective_date, requires_reacceptance, published_at`,
      [versionId, effectiveDate, policyText ?? null, changeSummary, requiresReacceptance, user.id]
    );

    if (requiresReacceptance) {
      // Flag all active users so their next request returns 403 with reason
      await pool.query(
        `UPDATE users SET privacy_reacceptance_required = TRUE
         WHERE role IN ('importer', 'surety_admin')`
      );
    }

    res.status(201).json({ version: result.rows[0] });
  }
);

// SOC 2 CC6.2: quarterly access review — surfaces accounts with no successful login
// in the past N days (default 90). Intended for use by the platform security team.
adminRouter.get(
  '/access-review',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const days = Math.max(1, parseInt(req.query.days as string) || 90);
    const accounts = await getStaleAccounts(days);
    res.json({
      staleDays: days,
      count: accounts.length,
      accounts,
    });
  }
);

// ── HTS rate cache management ─────────────────────────────────────────────────

/**
 * POST /admin/refresh-hts-cache
 *
 * Bust the 7-day HTS statutory rate cache for the supplied HTS codes, or for
 * all cached codes when `htsCodes` is omitted / empty.
 *
 * Body (optional):
 *   { "htsCodes": ["8471.30.01", "6110.20.20"] }
 *
 * The next lookup for any busted code will re-fetch from the USITC HTS API.
 */
adminRouter.post(
  '/refresh-hts-cache',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const parse = z
      .object({ htsCodes: z.array(z.string()).optional().default([]) })
      .safeParse(req.body);

    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
      return;
    }

    const deleted = await bustHtsCache(parse.data.htsCodes);

    res.json({
      message:
        parse.data.htsCodes.length === 0
          ? 'Full HTS rate cache cleared'
          : `Cache busted for ${parse.data.htsCodes.length} HTS code(s)`,
      deletedRows: deleted,
      htsCodes: parse.data.htsCodes.length > 0 ? parse.data.htsCodes : 'all',
    });
  }
);
// ── Oracle price feed endpoints ───────────────────────────────────────────────

const OracleFeedQuerySchema = z.object({
  importer_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /admin/oracle-feed
 *
 * Returns paginated rows from oracle_price_feed with ISO 8601 timestamps and
 * decimal-formatted collateral values.
 *
 * Query params:
 *   importer_id  UUID — filter to a specific importer
 *   from         ISO 8601 datetime — lower bound on created_at (inclusive)
 *   to           ISO 8601 datetime — upper bound on created_at (inclusive)
 *   page         integer ≥ 1, default 1
 *   per_page     integer 1–200, default 50
 */
adminRouter.get(
  '/oracle-feed',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const parse = OracleFeedQuerySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
      return;
    }
    const { importer_id, from, to, page, per_page } = parse.data;
    const offset = (page - 1) * per_page;

    // Build WHERE clause dynamically.
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (importer_id) {
      params.push(importer_id);
      conditions.push(`importer_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`created_at <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total matching rows.
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM oracle_price_feed ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    // Fetch the page.
    params.push(per_page, offset);
    const dataResult = await pool.query(
      `SELECT id, importer_id, importer_address,
              required_collateral::text    AS required_collateral,
              previous_collateral::text    AS previous_collateral,
              pct_change::text             AS pct_change,
              tx_hash, ledger_sequence, set_by, emergency_override,
              created_at
         FROM oracle_price_feed
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: dataResult.rows.map((row) => ({
        ...row,
        created_at: (row.created_at as Date).toISOString(),
      })),
      pagination: {
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page),
      },
    });
  }
);

/**
 * GET /admin/oracle-feed/export.csv
 *
 * Streams the full oracle_price_feed table as a CSV for compliance reporting.
 * Optional query params: importer_id, from, to (same as the paginated endpoint).
 */
adminRouter.get(
  '/oracle-feed/export.csv',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const filterSchema = OracleFeedQuerySchema.omit({ page: true, per_page: true });
    const parse = filterSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
      return;
    }
    const { importer_id, from, to } = parse.data;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (importer_id) {
      params.push(importer_id);
      conditions.push(`importer_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`created_at <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await pool.query(
      `SELECT id, importer_id, importer_address,
              required_collateral::text,
              previous_collateral::text,
              pct_change::text,
              tx_hash, ledger_sequence, set_by, emergency_override,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM oracle_price_feed ${where}
         ORDER BY created_at ASC`,
      params
    );

    const CSV_HEADER =
      'id,importer_id,importer_address,required_collateral,previous_collateral,' +
      'pct_change,tx_hash,ledger_sequence,set_by,emergency_override,created_at\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="oracle_price_feed_${new Date().toISOString().slice(0, 10)}.csv"`
    );

    res.write(CSV_HEADER);
    for (const row of rows.rows) {
      const line = [
        row.id,
        row.importer_id ?? '',
        row.importer_address,
        row.required_collateral,
        row.previous_collateral,
        row.pct_change,
        row.tx_hash,
        row.ledger_sequence,
        row.set_by,
        row.emergency_override,
        row.created_at,
      ]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',');
      res.write(line + '\n');
    }
    res.end();
  }
);

// ── #247: POST /admin/auto-top-up — batch auto-top-up ──────────────────────
//
// The per-importer POST /importers/:id/auto-top-up route (routes/importers.ts)
// enqueues one BullMQ job per call, so a surety admin managing N importers
// waits for N sequential job round-trips. This endpoint instead:
//   1. finds every eligible importer (mirrored balance below required
//      collateral) with a single query against the importer_metrics
//      materialized view instead of one lookup per importer, and
//   2. submits the Soroban auto_top_up calls directly and concurrently,
//      capped at CONCURRENCY_CAP in flight at once so a large batch can't
//      overrun the RPC node's rate limits.
//
// Complexity: O(n) Soroban calls for n eligible importers. Wall-clock time
// is bounded by ceil(n / CONCURRENCY_CAP) rounds of RPC latency in the
// worst case (a slow call only blocks the one worker slot it occupies, not
// the whole batch — see mapWithConcurrency), so n=100 at CONCURRENCY_CAP=10
// completes in roughly 10 rounds of ~200-600ms, comfortably under a 10s p95
// target. Space is O(n) for the eligible-importer list and results array.

const CONCURRENCY_CAP = 10;

interface EligibleImporter {
  importer_id: string;
  stellar_address: string;
}

interface AutoTopUpSuccess {
  importerId: string;
  txHash: string;
  amount: string;
}

/**
 * Bounded-concurrency worker pool: runs `worker` over `items`, never more
 * than `concurrency` invocations in flight at once. Workers share a single
 * cursor and each pulls the next unclaimed item as soon as it finishes its
 * previous one, so one slow item only ever occupies one worker slot rather
 * than stalling a whole fixed-size batch.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      try {
        results[current] = { status: 'fulfilled', value: await worker(items[current]!) };
      } catch (reason) {
        results[current] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

const BatchAutoTopUpSchema = z.object({
  importer_ids: z.array(z.string().uuid()).optional(),
});

adminRouter.post(
  '/auto-top-up',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const parse = BatchAutoTopUpSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
      return;
    }
    const { importer_ids } = parse.data;

    const params: unknown[] = [];
    let filterClause = '';
    if (importer_ids && importer_ids.length > 0) {
      params.push(importer_ids);
      filterClause = `AND im.importer_id = ANY($${params.length}::uuid[])`;
    }

    // Single query for every eligible importer — required kyc_status = 'approved'
    // (#229) since auto-top-up moves an importer's own collateral funds, and the
    // importer_metrics view already excludes soft-deleted importers.
    const eligible = await pool.query<EligibleImporter>(
      `SELECT im.importer_id, im.stellar_address
       FROM importer_metrics im
       JOIN importers i ON i.id = im.importer_id
      WHERE i.kyc_status = 'approved'
        AND im.required_collateral > 0
        AND im.current_balance < im.required_collateral
        ${filterClause}`,
      params
    );

    const outcomes = await mapWithConcurrency(
      eligible.rows,
      CONCURRENCY_CAP,
      async (row): Promise<AutoTopUpSuccess> => {
        const onChain = await contractClient.autoTopUp(platformKeypair, row.stellar_address);
        // Bare ON CONFLICT DO NOTHING: correct whether contract_events is
        // partitioned (#228) or not — see lib/contract-events-partitions.ts
        // for why an explicit column list can't be used once it is.
        await pool.query(
          `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, ledger_sequence, event_index)
         VALUES ($1, 'auto_top_up', $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
          [
            row.importer_id,
            onChain.result.toString(),
            onChain.txHash,
            onChain.ledgerSequence,
            onChain.applicationOrder,
          ]
        );
        return {
          importerId: row.importer_id,
          txHash: onChain.txHash,
          amount: onChain.result.toString(),
        };
      }
    );

    const errors: Array<{ id: string; reason: string }> = [];
    let succeeded = 0;
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        succeeded += 1;
      } else {
        errors.push({ id: eligible.rows[i]!.importer_id, reason: String(outcome.reason) });
      }
    });

    // Best-effort refresh so a subsequent call sees updated balances; a
    // failure here shouldn't turn a successful batch into an error response.
    await refreshImporterMetricsView().catch(() => undefined);

    res.json({ succeeded, failed: errors.length, errors });
  }
);

// ── #1007: Importer credit-line pre-approvals ───────────────────────────────
//
// surety_admin grants a time-boxed credit line that temporarily covers a
// collateral shortfall off-chain. Expiry is enforced by the hourly
// credit-line monitor job (jobs/credit-line-monitor.ts); after expiry the
// health check reverts to the strict requirement automatically.

const GrantCreditLineSchema = z
  .object({
    importerId: z.string().uuid(),
    // Stroops (integer string), matching the conventions used by deposits.
    amount: z
      .string()
      .regex(/^\d+$/, 'amount must be an integer string of stroops')
      .refine((v) => BigInt(v) > 0n, { message: 'amount must be positive' }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    durationHours: z.number().int().min(1).max(24 * 365).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .refine((d) => d.expiresAt || d.durationHours, {
    message: 'either expiresAt or durationHours is required',
  });

adminRouter.post('/credit-lines', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const parse = GrantCreditLineSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }
  const { importerId, amount, expiresAt, durationHours, reason } = parse.data;

  const importer = await pool.query(
    'SELECT id, user_id, legal_name FROM importers WHERE id = $1 AND deleted_at IS NULL',
    [importerId]
  );
  if (!importer.rowCount) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const now = Date.now();
  let expiryMs: number;
  if (expiresAt) {
    expiryMs = new Date(expiresAt).getTime();
    if (expiryMs <= now + 60_000) {
      res.status(400).json({ error: 'expiresAt must be in the future' });
      return;
    }
  } else {
    expiryMs = now + (durationHours ?? 168) * 60 * 60 * 1000;
  }

  const inserted = await pool.query(
    `INSERT INTO credit_lines (importer_id, granted_by, amount, reason, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, importer_id, granted_by, amount::text AS amount, reason, status,
               granted_at, expires_at, revoked_at, revoked_by, notified_expiring, created_at`,
    [importerId, user.id, amount, reason ?? null, new Date(expiryMs)]
  );
  const creditLine = inserted.rows[0];

  await logAudit(user.id, 'credit_line_granted', creditLine.id, {
    importerId,
    amount,
    expiresAt: creditLine.expires_at,
    reason: reason ?? null,
  });

  // Tell the importer their shortfall is temporarily covered (#1007 AC).
  const userId: string | null = importer.rows[0].user_id ?? null;
  if (userId) {
    await createNotification(
      userId,
      NOTIFICATION_KINDS.CREDIT_LINE_GRANTED,
      `A credit line of ${amount} stroops was granted to your account until ${new Date(creditLine.expires_at).toISOString()}. Deposit collateral before it expires to keep permanent coverage.`
    ).catch(() => undefined);
  }

  res.status(201).json({ creditLine });
});

const ListCreditLinesQuerySchema = z.object({
  importer_id: z.string().uuid().optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
});

adminRouter.get('/credit-lines', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const parse = ListCreditLinesQuerySchema.safeParse(req.query ?? {});
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'query', details: parse.error.issues });
    return;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (parse.data.importer_id) {
    params.push(parse.data.importer_id);
    conditions.push(`cl.importer_id = $${params.length}`);
  }
  if (parse.data.status) {
    params.push(parse.data.status);
    conditions.push(`cl.status = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT cl.id, cl.importer_id, i.legal_name AS importer_legal_name, cl.granted_by,
            cl.amount::text AS amount, cl.reason, cl.status, cl.granted_at, cl.expires_at,
            cl.revoked_at, cl.revoked_by, cl.notified_expiring, cl.created_at
     FROM credit_lines cl
     JOIN importers i ON i.id = cl.importer_id
     ${where}
     ORDER BY cl.created_at DESC
     LIMIT 500`,
    params
  );
  res.json({ creditLines: result.rows });
});

adminRouter.post(
  '/credit-lines/:id/revoke',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const parse = z.object({ reason: z.string().max(500).optional() }).safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
      return;
    }

    const result = await pool.query(
      `UPDATE credit_lines
          SET status = 'revoked', revoked_at = now(), revoked_by = $1
        WHERE id = $2 AND status = 'active'
        RETURNING id, importer_id, granted_by, amount::text AS amount, reason, status,
                  granted_at, expires_at, revoked_at, revoked_by, notified_expiring, created_at`,
      [user.id, req.params.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'active credit line not found' });
      return;
    }
    const creditLine = result.rows[0];

    await logAudit(user.id, 'credit_line_revoked', creditLine.id, {
      importerId: creditLine.importer_id,
      amount: creditLine.amount,
      reason: parse.data.reason ?? null,
    });

    res.json({ creditLine });
  }
);

// ── #1008: Dispute resolution recommendation + admin resolution ─────────────
//
// GET returns an advisory suggestion only; POST performs the actual
// resolve_dispute decision (never auto-triggered — see
// docs/dispute-recommendation.md).

adminRouter.get(
  '/disputes',
  requireRole('surety_admin'),
  async (_req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT cd.id, cd.importer_id, i.legal_name AS importer_legal_name, i.stellar_address,
              cd.old_required::text AS old_required, cd.new_required::text AS new_required,
              cd.raise_tx_hash, cd.status, cd.raised_at, cd.resolved_at, cd.resolve_tx_hash
       FROM collateral_disputes cd
       JOIN importers i ON i.id = cd.importer_id
       WHERE cd.status = 'open'
       ORDER BY cd.raised_at DESC`
    );

    // #992: Surface evidence list to surety_admin before calling resolve_dispute
    const disputeIds = result.rows.map((d) => d.id);
    const evidenceByDispute = new Map<string, any[]>();
    if (disputeIds.length > 0) {
      const evResult = await pool.query(
        `SELECT id, dispute_id, importer_id, file_name, mime_type, file_size_bytes,
                s3_key_encrypted, virus_scan_status, notes, created_at
         FROM dispute_evidence
         WHERE dispute_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [disputeIds]
      );
      for (const ev of evResult.rows) {
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
    }

    const disputes = result.rows.map((d) => ({
      ...d,
      evidence: evidenceByDispute.get(d.id) ?? [],
    }));

    res.json({ disputes });
  }
);

// GET /disputes/:id/evidence — surety_admin views evidence for a specific dispute before resolving (#992)
adminRouter.get(
  '/disputes/:id/evidence',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const disputeId = String(req.params.id ?? '');
    const dispute = await pool.query(
      `SELECT cd.id, cd.importer_id, cd.status, i.legal_name, i.stellar_address
       FROM collateral_disputes cd
       JOIN importers i ON i.id = cd.importer_id
       WHERE cd.id = $1`,
      [disputeId]
    );
    if (!dispute.rowCount) {
      res.status(404).json({ error: 'dispute not found' });
      return;
    }
    const evidenceRes = await pool.query(
      `SELECT id, dispute_id, importer_id, file_name, mime_type, file_size_bytes,
              s3_key_encrypted, virus_scan_status, notes, created_at
       FROM dispute_evidence
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId]
    );
    const evidence = evidenceRes.rows.map((row) => ({
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
    res.json({ dispute: dispute.rows[0], evidence });
  }
);

adminRouter.get(
  '/disputes/:importerId/recommendation',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const importerId = String(req.params.importerId ?? '');
    if (!z.string().uuid().safeParse(importerId).success) {
      res.status(400).json({ error: 'invalid importer id' });
      return;
    }
    const recommendation = await buildDisputeRecommendation(importerId);
    if (!recommendation) {
      res.status(404).json({ error: 'importer not found' });
      return;
    }
    res.json({ recommendation });
  }
);

const ResolveDisputeSchema = z.object({
  accept: z.boolean(),
  note: z.string().max(500).optional(),
});

adminRouter.post(
  '/disputes/:id/resolve',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const parse = ResolveDisputeSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
      return;
    }
    const { accept, note } = parse.data;

    const dispute = await pool.query(
      `SELECT cd.id, cd.importer_id, cd.status, i.stellar_address, i.legal_name
       FROM collateral_disputes cd
       JOIN importers i ON i.id = cd.importer_id
       WHERE cd.id = $1`,
      [req.params.id]
    );
    if (!dispute.rowCount) {
      res.status(404).json({ error: 'dispute not found' });
      return;
    }
    if (dispute.rows[0].status !== 'open') {
      res.status(409).json({ error: 'dispute is not open' });
      return;
    }

    // Explicit admin decision — the recommendation is never applied here.
    const onChain = await contractClient.resolveDispute(
      platformKeypair,
      dispute.rows[0].stellar_address,
      accept
    );

    const newStatus = accept ? 'resolved_accepted' : 'resolved_rejected';
    const updated = await pool.query(
      `UPDATE collateral_disputes
          SET status = $1, resolved_at = now(), resolve_tx_hash = $2
        WHERE id = $3
        RETURNING id, importer_id, old_required::text AS old_required,
                  new_required::text AS new_required, status, raised_at, resolved_at,
                  resolve_tx_hash`,
      [newStatus, onChain.txHash, req.params.id]
    );

    await pool.query(
      `INSERT INTO contract_events (importer_id, kind, tx_hash, raw)
       VALUES ($1, 'dispute_resolved', $2, $3)
       ON CONFLICT DO NOTHING`,
      [
        dispute.rows[0].importer_id,
        onChain.txHash,
        JSON.stringify({ accept, resolvedBy: user.id }),
      ]
    );

    await logAudit(user.id, 'dispute_resolved', dispute.rows[0].id, {
      importerId: dispute.rows[0].importer_id,
      accept,
      txHash: onChain.txHash,
      txUrl: explorerTx(onChain.txHash),
      note: note ?? null,
    });

    res.json({ dispute: updated.rows[0], txUrl: explorerTx(onChain.txHash) });
  }
);

// ── #1018: Oracle Signer Rotation Workflow Endpoints ─────────────────────────

const ProposeRotationSchema = z.object({
  newSigners: z.array(z.string().length(56)).length(3),
});

// POST /admin/oracle-signers/propose — propose a new set of 3 oracle signers
adminRouter.post('/oracle-signers/propose', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const parse = ProposeRotationSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', target: 'body', details: parse.error.issues });
    return;
  }
  const { newSigners } = parse.data;

  // Enforce distinct signers
  if (new Set(newSigners).size !== 3) {
    res.status(400).json({ error: 'new signers must be 3 distinct Stellar addresses' });
    return;
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO oracle_signer_rotations (proposed_by, new_signers, threshold, status)
       VALUES ($1, $2, 2, 'pending_signatures')
       RETURNING id, proposed_by, new_signers, threshold, approvals, status, created_at`,
      [user.id, JSON.stringify(newSigners)]
    );

    await logAudit(user.id, 'oracle_signer_rotation_proposed', inserted.rows[0].id, { newSigners });

    res.status(201).json({ proposal: inserted.rows[0] });
  } catch (err: any) {
    console.error('[admin] failed to propose oracle signer rotation:', err);
    res.status(500).json({ error: 'failed to create signer rotation proposal' });
  }
});

// GET /admin/oracle-signers/active — get active proposal and on-chain signers
adminRouter.get('/oracle-signers/active', requireRole('surety_admin'), async (_req: Request, res: Response) => {
  try {
    const proposalRes = await pool.query(
      `SELECT id, proposed_by, new_signers, threshold, approvals, status, created_at
       FROM oracle_signer_rotations
       WHERE status = 'pending_signatures'
       ORDER BY created_at DESC LIMIT 1`
    );

    let onChainSigners: string[] = [];
    try {
      onChainSigners = await contractClient.getOracleSigners();
    } catch {
      // Fallback if contract client mock/network is unavailable
      onChainSigners = [];
    }

    res.json({
      activeProposal: proposalRes.rows[0] ?? null,
      onChainSigners,
    });
  } catch (err: any) {
    console.error('[admin] failed to fetch active oracle signer rotation:', err);
    res.status(500).json({ error: 'failed to fetch active rotation proposal' });
  }
});

// POST /admin/oracle-signers/:id/approve — add approval to proposal
adminRouter.post('/oracle-signers/:id/approve', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const proposalId = req.params.id;

  try {
    const proposalRes = await pool.query(
      `SELECT id, approvals, threshold, status FROM oracle_signer_rotations WHERE id = $1 AND status = 'pending_signatures'`,
      [proposalId]
    );

    if (!proposalRes.rowCount) {
      res.status(404).json({ error: 'active proposal not found' });
      return;
    }

    const proposal = proposalRes.rows[0];
    const approvals: Array<{ approverId: string; approvedAt: string }> = proposal.approvals || [];

    if (approvals.some((a) => a.approverId === user.id)) {
      res.status(409).json({ error: 'you have already approved this proposal' });
      return;
    }

    approvals.push({ approverId: user.id, approvedAt: new Date().toISOString() });

    const updated = await pool.query(
      `UPDATE oracle_signer_rotations SET approvals = $1 WHERE id = $2 RETURNING id, new_signers, threshold, approvals, status`,
      [JSON.stringify(approvals), proposalId]
    );

    await logAudit(user.id, 'oracle_signer_rotation_approved', proposalId, { approvalCount: approvals.length });

    res.json({ proposal: updated.rows[0] });
  } catch (err: any) {
    console.error('[admin] failed to approve oracle signer rotation:', err);
    res.status(500).json({ error: 'failed to submit approval' });
  }
});

// POST /admin/oracle-signers/:id/execute — execute signer rotation on-chain
adminRouter.post('/oracle-signers/:id/execute', requireRole('surety_admin'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const proposalId = req.params.id;

  try {
    const proposalRes = await pool.query(
      `SELECT id, new_signers, threshold, approvals, status FROM oracle_signer_rotations WHERE id = $1 AND status = 'pending_signatures'`,
      [proposalId]
    );

    if (!proposalRes.rowCount) {
      res.status(404).json({ error: 'active proposal not found' });
      return;
    }

    const proposal = proposalRes.rows[0];
    const approvals = proposal.approvals || [];

    if (approvals.length < proposal.threshold) {
      res.status(400).json({ error: `insufficient approvals: need ${proposal.threshold}, got ${approvals.length}` });
      return;
    }

    const newSigners: string[] = typeof proposal.new_signers === 'string' ? JSON.parse(proposal.new_signers) : proposal.new_signers;

    const onChain = await contractClient.updateOracleSigners(
      platformKeypair,
      newSigners,
      [platformKeypair.publicKey(), oracleKeypair.publicKey()]
    );

    const updated = await pool.query(
      `UPDATE oracle_signer_rotations
       SET status = 'executed', tx_hash = $1, executed_at = NOW()
       WHERE id = $2
       RETURNING id, new_signers, status, tx_hash, executed_at`,
      [onChain.txHash, proposalId]
    );

    await logAudit(user.id, 'oracle_signer_rotation_executed', proposalId, {
      txHash: onChain.txHash,
      newSigners,
    });

    res.json({
      proposal: updated.rows[0],
      txUrl: explorerTx(onChain.txHash),
    });
  } catch (err: any) {
    console.error('[admin] failed to execute oracle signer rotation:', err);
    res.status(500).json({ error: 'failed to execute signer rotation on-chain' });
  }
});

// GET /admin/oracle-signers/history — rotation audit history
adminRouter.get('/oracle-signers/history', requireRole('surety_admin'), async (_req: Request, res: Response) => {
  try {
    const historyRes = await pool.query(
      `SELECT r.id, r.proposed_by, u.email AS proposed_by_email, r.new_signers, r.threshold, r.approvals, r.status, r.tx_hash, r.created_at, r.executed_at
       FROM oracle_signer_rotations r
       LEFT JOIN users u ON u.id = r.proposed_by
       ORDER BY r.created_at DESC LIMIT 50`
    );

    res.json({ history: historyRes.rows });
  } catch (err: any) {
    console.error('[admin] failed to fetch oracle signer rotation history:', err);
    res.status(500).json({ error: 'failed to fetch rotation history' });
  }
});

