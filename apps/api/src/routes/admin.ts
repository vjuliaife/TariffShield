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
