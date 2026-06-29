import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, requireRole, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";
import { platformKeypair, oracleKeypair } from "../stellar.js";

export const adminRouter = Router();
adminRouter.use(authMiddleware);
adminRouter.use(privacyReacceptanceGate);
adminRouter.use(tosReacceptanceGate);

adminRouter.get("/oracle-alerts", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const r = await pool.query(
    "SELECT * FROM oracle_alerts ORDER BY alerted_at DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  
  const countR = await pool.query("SELECT COUNT(*) FROM oracle_alerts");
  const total = parseInt(countR.rows[0]?.count || "0");

  res.json({
    alerts: r.rows,
    total,
    limit,
    offset,
  });
});

adminRouter.patch("/oracle-alerts/:id/acknowledge", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }

  const alertId = req.params.id;
  const r = await pool.query(
    "UPDATE oracle_alerts SET acknowledged_at = now() WHERE id = $1 RETURNING *",
    [alertId]
  );

  if (r.rowCount === 0) {
    res.status(404).json({ error: "alert not found" });
    return;
  }

  res.json({ alert: r.rows[0] });
});

// #339 — GET /admin/roles — operational visibility into current role addresses
adminRouter.get("/roles", requireRole("surety_admin"), (_req: Request, res: Response) => {
  res.json({
    generalAdmin: platformKeypair.publicKey(),
    oracleAdmin: oracleKeypair.publicKey(),
    rolesAreDistinct: platformKeypair.publicKey() !== oracleKeypair.publicKey(),
  });
});

// #322 — POST /admin/privacy-policy/publish — publish a new privacy policy version
adminRouter.post(
  "/privacy-policy/publish",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const parse = z.object({
      versionId: z.string().min(1),
      effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      changeSummary: z.string().min(10),
      policyText: z.string().optional(),
      requiresReacceptance: z.boolean().default(false),
    }).safeParse(req.body);

    if (!parse.success) {
      res.status(400).json({ error: "invalid input", details: parse.error.issues });
      return;
    }
    const { versionId, effectiveDate, changeSummary, policyText, requiresReacceptance } = parse.data;

    const result = await pool.query(
      `INSERT INTO privacy_policy_versions
         (version_id, effective_date, policy_text, change_summary, requires_reacceptance, published_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, version_id, effective_date, requires_reacceptance, published_at`,
      [versionId, effectiveDate, policyText ?? null, changeSummary, requiresReacceptance, user.id],
    );

    if (requiresReacceptance) {
      // Flag all active users so their next request returns 403 with reason
      await pool.query(
        `UPDATE users SET privacy_reacceptance_required = TRUE
         WHERE role IN ('importer', 'surety_admin')`,
      );
    }

    res.status(201).json({ version: result.rows[0] });
  },
);

// SOC 2 CC6.2: quarterly access review — surfaces accounts with no successful login
// in the past N days (default 90). Intended for use by the platform security team.
adminRouter.get(
  "/access-review",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const days = Math.max(1, parseInt(req.query.days as string) || 90);
    const accounts = await getStaleAccounts(days);
    res.json({
      staleDays: days,
      count: accounts.length,
      accounts,
    });
  },
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
  "/oracle-feed",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const parse = OracleFeedQuerySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: "invalid query params", details: parse.error.issues });
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching rows.
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM oracle_price_feed ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

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
      params,
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
  },
);

/**
 * GET /admin/oracle-feed/export.csv
 *
 * Streams the full oracle_price_feed table as a CSV for compliance reporting.
 * Optional query params: importer_id, from, to (same as the paginated endpoint).
 */
adminRouter.get(
  "/oracle-feed/export.csv",
  requireRole("surety_admin"),
  async (req: Request, res: Response) => {
    const filterSchema = OracleFeedQuerySchema.omit({ page: true, per_page: true });
    const parse = filterSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: "invalid query params", details: parse.error.issues });
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await pool.query(
      `SELECT id, importer_id, importer_address,
              required_collateral::text,
              previous_collateral::text,
              pct_change::text,
              tx_hash, ledger_sequence, set_by, emergency_override,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM oracle_price_feed ${where}
         ORDER BY created_at ASC`,
      params,
    );

    const CSV_HEADER =
      "id,importer_id,importer_address,required_collateral,previous_collateral," +
      "pct_change,tx_hash,ledger_sequence,set_by,emergency_override,created_at\n";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="oracle_price_feed_${new Date().toISOString().slice(0, 10)}.csv"`,
    );

    res.write(CSV_HEADER);
    for (const row of rows.rows) {
      const line = [
        row.id,
        row.importer_id ?? "",
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
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");
      res.write(line + "\n");
    }
    res.end();
  },
);
