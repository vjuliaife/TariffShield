import { Router, type Request, type Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { z } from 'zod';
import { pool, logAudit } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const apiKeysRouter = Router();
apiKeysRouter.use(authMiddleware);
apiKeysRouter.use(privacyReacceptanceGate);
apiKeysRouter.use(tosReacceptanceGate);

const CreateApiKeySchema = z.object({
  label: z.string().max(100).optional(),
  scopes: z.array(z.string()).default(['read', 'write']).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10000).default(60).optional(),
  expiresInDays: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

// POST /account/api-keys — create new API key (secret returned ONCE)
apiKeysRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = CreateApiKeySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  // Look up importer for this user to scope the key
  const impRes = await pool.query<{ id: string }>(
    'SELECT id FROM importers WHERE user_id = $1',
    [user.id]
  );
  const importerId = impRes.rows[0]?.id ?? null;

  // Generate random secret: ts_live_ + 32 base64url characters
  const rawSecret = `ts_live_${randomBytes(24).toString('base64url')}`;
  const prefix = `ts_live_${rawSecret.slice(8, 14)}...`;
  const keyHash = createHash('sha256').update(rawSecret).digest('hex');

  let expiresAtDate: Date | null = null;
  if (parse.data.expiresAt) {
    expiresAtDate = new Date(parse.data.expiresAt);
  } else if (parse.data.expiresInDays) {
    expiresAtDate = new Date(Date.now() + parse.data.expiresInDays * 24 * 60 * 60 * 1000);
  }

  const inserted = await pool.query<{
    id: string;
    user_id: string;
    importer_id: string | null;
    prefix: string;
    label: string | null;
    scopes: string[];
    rate_limit_per_min: number;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `INSERT INTO api_keys (user_id, importer_id, key_hash, prefix, label, scopes, rate_limit_per_min, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, importer_id, prefix, label, scopes, rate_limit_per_min, expires_at, created_at`,
    [
      user.id,
      importerId,
      keyHash,
      prefix,
      parse.data.label ?? null,
      parse.data.scopes ?? ['read', 'write'],
      parse.data.rateLimitPerMin ?? 60,
      expiresAtDate,
    ]
  );

  const row = inserted.rows[0]!;

  await logAudit(user.id, 'create_api_key', importerId ?? user.id, {
    apiKeyId: row.id,
    prefix: row.prefix,
    label: row.label,
  });

  res.status(201).json({
    apiKey: {
      id: row.id,
      importerId: row.importer_id,
      prefix: row.prefix,
      label: row.label,
      scopes: row.scopes,
      rateLimitPerMin: row.rate_limit_per_min,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      secretKey: rawSecret, // Secret returned only ONCE upon creation (#995 AC 4)
    },
    warning: 'The secretKey is shown only once. Store it securely; it cannot be retrieved later.',
  });
});

// GET /account/api-keys — list API keys (secret NEVER returned)
apiKeysRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const r = await pool.query<{
    id: string;
    importer_id: string | null;
    prefix: string;
    label: string | null;
    scopes: string[];
    rate_limit_per_min: number;
    last_used_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, importer_id, prefix, label, scopes, rate_limit_per_min,
            last_used_at, expires_at, revoked_at, created_at, updated_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [user.id]
  );

  res.json({ apiKeys: r.rows });
});

// GET /account/api-keys/:id — get single key metadata
apiKeysRouter.get('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const r = await pool.query<{
    id: string;
    importer_id: string | null;
    prefix: string;
    label: string | null;
    scopes: string[];
    rate_limit_per_min: number;
    last_used_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, importer_id, prefix, label, scopes, rate_limit_per_min,
            last_used_at, expires_at, revoked_at, created_at, updated_at
     FROM api_keys
     WHERE id = $1 AND user_id = $2`,
    [req.params.id, user.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'api key not found' });
    return;
  }

  res.json({ apiKey: r.rows[0]! });
});

// POST /account/api-keys/:id/revoke & DELETE /account/api-keys/:id — revoke API key
async function handleRevokeApiKey(req: Request, res: Response): Promise<void> {
  const user = (req as AuthedRequest).user;

  const r = await pool.query<{
    id: string;
    importer_id: string | null;
    prefix: string;
    label: string | null;
    revoked_at: Date;
  }>(
    `UPDATE api_keys
     SET revoked_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id, importer_id, prefix, label, revoked_at`,
    [req.params.id, user.id]
  );

  if (!r.rowCount) {
    res.status(404).json({ error: 'api key not found or already revoked' });
    return;
  }

  const revoked = r.rows[0]!;

  await logAudit(user.id, 'revoke_api_key', revoked.importer_id ?? user.id, {
    apiKeyId: revoked.id,
    prefix: revoked.prefix,
  });

  res.json({ success: true, apiKey: revoked });
}

apiKeysRouter.post('/:id/revoke', handleRevokeApiKey);
apiKeysRouter.delete('/:id', handleRevokeApiKey);
