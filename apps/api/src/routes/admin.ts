import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { authMiddleware, type AuthedRequest } from "../auth.js";

export const adminRouter = Router();
adminRouter.use(authMiddleware);

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

// ── Issue #313: Monthly retention compliance report ───────────────────────────

adminRouter.get("/retention-report", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }

  const [deletedR, retainedR, holdsR, upcomingR] = await Promise.all([
    // Records deleted/anonymized this month
    pool.query(
      `SELECT record_category, SUM(record_count) AS count
       FROM retention_audit_log
       WHERE job_run_at >= date_trunc('month', now())
       GROUP BY record_category`,
    ),
    // Records currently past expiry but on hold (retained due to hold)
    pool.query(
      `SELECT rh.record_table, COUNT(*) AS count
       FROM retention_holds rh
       WHERE rh.released_at IS NULL
       GROUP BY rh.record_table`,
    ),
    // Active holds count
    pool.query(`SELECT COUNT(*) AS count FROM retention_holds WHERE released_at IS NULL`),
    // Records expiring in next 90 days
    pool.query(
      `SELECT 'importers' AS category, COUNT(*) AS count
         FROM importers
         WHERE retention_expires_at BETWEEN now() AND now() + INTERVAL '90 days'
       UNION ALL
       SELECT 'tariff_uploads', COUNT(*)
         FROM tariff_uploads
         WHERE retention_expires_at BETWEEN now() AND now() + INTERVAL '90 days'
       UNION ALL
       SELECT 'aml_screenings', COUNT(*)
         FROM aml_screenings
         WHERE retention_expires_at BETWEEN now() AND now() + INTERVAL '90 days'`,
    ),
  ]);

  res.json({
    report_generated_at: new Date().toISOString(),
    deleted_this_month: deletedR.rows,
    records_on_hold: retainedR.rows,
    active_hold_count: Number(holdsR.rows[0]?.count ?? 0),
    expiring_next_90_days: upcomingR.rows,
  });
});

// ── Issue #313: Retention hold management ────────────────────────────────────

adminRouter.post("/retention-holds", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }
  const { record_table, record_id, reason } = req.body as { record_table?: string; record_id?: string; reason?: string };
  if (!record_table || !record_id || !reason) {
    res.status(400).json({ error: "record_table, record_id, reason required" });
    return;
  }
  const r = await pool.query(
    `INSERT INTO retention_holds (record_table, record_id, reason, held_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [record_table, record_id, reason, user.id],
  );
  res.status(201).json({ hold: r.rows[0] });
});

adminRouter.delete("/retention-holds/:id", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }
  const r = await pool.query(
    `UPDATE retention_holds SET released_at = now() WHERE id = $1 AND released_at IS NULL RETURNING *`,
    [req.params.id],
  );
  if (!r.rowCount) {
    res.status(404).json({ error: "hold not found or already released" });
    return;
  }
  res.json({ hold: r.rows[0] });
});
