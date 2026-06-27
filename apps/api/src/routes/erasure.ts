import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool, createDataErasureRequest } from "../db.js";
import { authMiddleware, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

export const erasureRouter = Router();
erasureRouter.use(authMiddleware);
erasureRouter.use(privacyReacceptanceGate);
erasureRouter.use(tosReacceptanceGate);

const ErasureRequestSchema = z.object({
  reason: z.string().optional(),
});

erasureRouter.post("/account/erasure-request", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const parse = ErasureRequestSchema.safeParse(req.body);

  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }

  const importerResult = await pool.query("SELECT id FROM importers WHERE user_id = $1", [user.id]);
  const importerId = importerResult.rows[0]?.id ?? null;

  const requestId = await createDataErasureRequest(user.id, importerId);

  const result = await pool.query(
    "SELECT id, request_id, status, requested_at, sla_deadline FROM data_erasure_requests WHERE id = $1",
    [requestId],
  );

  const request = result.rows[0];
  if (!request) {
    res.status(500).json({ error: "failed to retrieve erasure request" });
    return;
  }
  res.status(202).json({
    requestId: request.request_id,
    status: request.status,
    requestedAt: request.requested_at,
    slaDealineAt: request.sla_deadline,
  });
});

erasureRouter.get("/account/erasure-request/:requestId", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const requestId = String(req.params.requestId ?? "");

  const result = await pool.query(
    `SELECT id, request_id, status, requested_at, sla_deadline, affected_fields, error_message
     FROM data_erasure_requests
     WHERE request_id = $1 AND user_id = $2`,
    [requestId, user.id],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "request not found" });
    return;
  }

  const request = result.rows[0];
  if (!request) {
    res.status(404).json({ error: "request not found" });
    return;
  }
  res.json({
    requestId: request.request_id,
    status: request.status,
    requestedAt: request.requested_at,
    slaDealineAt: request.sla_deadline,
    affectedFields: request.affected_fields,
    errorMessage: request.error_message,
  });
});
