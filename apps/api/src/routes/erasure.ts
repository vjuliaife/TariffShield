import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool, createDataErasureRequest, logAudit } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const erasureRouter = Router();
erasureRouter.use(authMiddleware);
erasureRouter.use(privacyReacceptanceGate);
erasureRouter.use(tosReacceptanceGate);

const ErasureRequestSchema = z.object({
  reason: z.string().optional(),
});

erasureRouter.post('/account/erasure-request', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const parse = ErasureRequestSchema.safeParse(req.body);

  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  const importerResult = await pool.query('SELECT id FROM importers WHERE user_id = $1', [user.id]);
  const importerId = importerResult.rows[0]?.id ?? null;

  const requestId = await createDataErasureRequest(user.id, importerId);

  const result = await pool.query(
    'SELECT id, request_id, status, requested_at, sla_deadline FROM data_erasure_requests WHERE id = $1',
    [requestId]
  );

  const request = result.rows[0];
  if (!request) {
    res.status(500).json({ error: 'failed to retrieve erasure request' });
    return;
  }
  res.status(202).json({
    requestId: request.request_id,
    status: request.status,
    requestedAt: request.requested_at,
    slaDealineAt: request.sla_deadline,
  });
});

erasureRouter.get('/account/erasure-request/:requestId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const requestId = String(req.params.requestId ?? '');

  const result = await pool.query(
    `SELECT id, request_id, status, requested_at, sla_deadline, affected_fields, error_message
     FROM data_erasure_requests
     WHERE request_id = $1 AND user_id = $2`,
    [requestId, user.id]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: 'request not found' });
    return;
  }

  const request = result.rows[0];
  if (!request) {
    res.status(404).json({ error: 'request not found' });
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

// ── #1031: Data retention policy configuration ──────────────────────────────

const RetentionPolicySchema = z.object({
  dataCategory: z.enum(['documents', 'logs', 'events', 'tariff_uploads']),
  retentionDays: z.number().int().positive(),
});

// GET /api/v1/erasure/retention-policies — list retention policies for the importer
erasureRouter.get('/retention-policies', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  
  const importerResult = await pool.query('SELECT id FROM importers WHERE user_id = $1', [user.id]);
  const importerId = importerResult.rows[0]?.id ?? null;
  
  if (!importerId) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const result = await pool.query(
    'SELECT id, data_category, retention_days, is_regulatory_required, created_at, updated_at FROM data_retention_policies WHERE importer_id = $1 ORDER BY data_category',
    [importerId]
  );

  res.json({ policies: result.rows });
});

// POST /api/v1/erasure/retention-policies — set retention policy for a data category
erasureRouter.post('/retention-policies', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  
  const parse = RetentionPolicySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  const importerResult = await pool.query('SELECT id FROM importers WHERE user_id = $1', [user.id]);
  const importerId = importerResult.rows[0]?.id ?? null;
  
  if (!importerId) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const { dataCategory, retentionDays } = parse.data;

  // Regulatory-required categories are excluded from configurable retention
  const regulatoryCategories = ['documents']; // KYC documents have regulatory retention
  const isRegulatoryRequired = regulatoryCategories.includes(dataCategory);

  const result = await pool.query(
    `INSERT INTO data_retention_policies (importer_id, data_category, retention_days, is_regulatory_required)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (importer_id, data_category) 
     DO UPDATE SET retention_days = $3, updated_at = now()
     RETURNING id, data_category, retention_days, is_regulatory_required, created_at, updated_at`,
    [importerId, dataCategory, retentionDays, isRegulatoryRequired]
  );

  await logAudit(user.id, 'set_retention_policy', importerId, {
    dataCategory,
    retentionDays,
    isRegulatoryRequired,
  });

  res.json({ policy: result.rows[0] });
});

// DELETE /api/v1/erasure/retention-policies/:id — delete a retention policy
erasureRouter.delete('/retention-policies/:id', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  
  const importerResult = await pool.query('SELECT id FROM importers WHERE user_id = $1', [user.id]);
  const importerId = importerResult.rows[0]?.id ?? null;
  
  if (!importerId) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const result = await pool.query(
    'DELETE FROM data_retention_policies WHERE id = $1 AND importer_id = $2 AND is_regulatory_required = FALSE',
    [req.params.id, importerId]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: 'policy not found or is regulatory-required' });
    return;
  }

  res.json({ success: true });
});
