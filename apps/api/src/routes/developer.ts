import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { getApiKeyUsageSummary } from '../services/api-key-usage.js';

/**
 * Issue #1043 — developer dashboard endpoints.
 *
 * GET /developer/keys                  → the caller's API keys (metadata only)
 * GET /developer/keys/:id/usage        → usage rollup for one key
 * GET /developer/usage                 → usage rollup across all the caller's keys
 */
export const developerRouter = Router();
developerRouter.use(authMiddleware);
developerRouter.use(privacyReacceptanceGate);
developerRouter.use(tosReacceptanceGate);

interface KeyRow {
  id: string;
  prefix: string;
  label: string | null;
  scopes: string[];
  rate_limit_per_min: number | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

async function listKeys(userId: string): Promise<KeyRow[]> {
  const res = await pool.query<KeyRow>(
    `SELECT id, prefix, label, scopes, rate_limit_per_min,
            last_used_at, expires_at, revoked_at, created_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows;
}

developerRouter.get('/keys', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  res.json({ keys: await listKeys(user.id) });
});

developerRouter.get('/keys/:id/usage', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const keys = await listKeys(user.id);
  const key = keys.find((k) => k.id === String(req.params.id));
  if (!key) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }
  const summary = await getApiKeyUsageSummary({
    apiKeyId: key.id,
    keyIds: [key.id],
    rateLimitPerMin: key.rate_limit_per_min,
  });
  res.json({ usage: summary });
});

developerRouter.get('/usage', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const keys = await listKeys(user.id);
  const active = keys.filter((k) => !k.revoked_at);
  // Aggregate quota is the tightest configured per-key limit, if any.
  const limits = active
    .map((k) => k.rate_limit_per_min)
    .filter((v): v is number => typeof v === 'number');
  const rateLimitPerMin = limits.length ? Math.min(...limits) : null;

  const summary = await getApiKeyUsageSummary({
    apiKeyId: null,
    keyIds: active.map((k) => k.id),
    rateLimitPerMin,
  });
  res.json({
    usage: summary,
    keyCount: active.length,
  });
});
