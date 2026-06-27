// #322 — Privacy Policy Versioning and Re-Acceptance Flow
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

export const privacyRouter = Router();
privacyRouter.use(authMiddleware);
privacyRouter.use(privacyReacceptanceGate);
privacyRouter.use(tosReacceptanceGate);

// GET /api/v1/account/privacy-policy-history — user's acceptance history
privacyRouter.get("/privacy-policy-history", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const rows = await pool.query(
    `SELECT ppa.policy_version_id, ppa.accepted_at, ppa.acceptance_channel,
            ppv.effective_date, ppv.change_summary, ppv.requires_reacceptance
     FROM privacy_policy_acceptances ppa
     JOIN privacy_policy_versions ppv ON ppv.version_id = ppa.policy_version_id
     WHERE ppa.user_id = $1
     ORDER BY ppa.accepted_at DESC`,
    [user.id],
  );
  res.json({ acceptances: rows.rows });
});

// POST /api/v1/account/accept-privacy-policy — re-accept current policy version
privacyRouter.post("/accept-privacy-policy", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ versionId: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "versionId is required" });
    return;
  }

  const version = await pool.query(
    "SELECT version_id FROM privacy_policy_versions WHERE version_id = $1",
    [parse.data.versionId],
  );
  if (!version.rowCount) {
    res.status(404).json({ error: "policy version not found" });
    return;
  }

  await pool.query(
    `INSERT INTO privacy_policy_acceptances
       (user_id, policy_version_id, ip_address, acceptance_channel)
     VALUES ($1, $2, $3, 'in_app')
     ON CONFLICT (user_id, policy_version_id) DO NOTHING`,
    [user.id, parse.data.versionId, req.ip ?? null],
  );

  // Clear the re-acceptance flag for this user
  await pool.query(
    "UPDATE users SET privacy_reacceptance_required = FALSE WHERE id = $1",
    [user.id],
  );

  res.json({ accepted: true, versionId: parse.data.versionId });
});

// GET /api/v1/privacy-policy/current — public: current policy version
privacyRouter.get("/current-version", async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT version_id, effective_date, change_summary, requires_reacceptance
     FROM privacy_policy_versions
     ORDER BY effective_date DESC
     LIMIT 1`,
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "no privacy policy published yet" });
    return;
  }
  res.json({ version: result.rows[0] });
});
