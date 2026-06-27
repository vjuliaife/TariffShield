import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

export const tosRouter = Router();
tosRouter.use(authMiddleware);
tosRouter.use(privacyReacceptanceGate);
tosRouter.use(tosReacceptanceGate);

// GET /api/v1/account/tos-history — user's ToS acceptance history
tosRouter.get("/tos-history", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const rows = await pool.query(
    `SELECT ta.tos_version, ta.accepted_at, ta.acceptance_method, ta.ip_address,
            tv.effective_date, tv.change_summary
     FROM tos_acceptances ta
     JOIN tos_versions tv ON tv.version_id = ta.tos_version
     WHERE ta.user_id = $1
     ORDER BY ta.accepted_at DESC`,
    [user.id],
  );
  res.json({ acceptances: rows.rows });
});

// POST /api/v1/account/accept-tos — accept a new ToS version
tosRouter.post("/accept-tos", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ versionId: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "versionId is required" });
    return;
  }

  const version = await pool.query(
    "SELECT version_id FROM tos_versions WHERE version_id = $1",
    [parse.data.versionId],
  );
  if (!version.rowCount) {
    res.status(404).json({ error: "ToS version not found" });
    return;
  }

  await pool.query(
    `INSERT INTO tos_acceptances
       (user_id, tos_version, ip_address, user_agent, acceptance_method)
     VALUES ($1, $2, $3, $4, 're-acceptance')`,
    [user.id, parse.data.versionId, req.ip ?? null, req.get("user-agent") ?? null],
  );

  await pool.query(
    "UPDATE users SET tos_reacceptance_required = FALSE WHERE id = $1",
    [user.id],
  );

  res.json({ accepted: true, versionId: parse.data.versionId });
});
