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
