import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool, logAudit } from '../db.js';
import { authMiddleware, requireRole, type AuthedRequest } from '../auth.js';

// #988 — broker delegated-access grants. Mounted at '/importers' from
// index.ts, alongside the existing importer-scoped resource routes this
// extends (see routes/importers.ts).
export const brokerRouter = Router();
brokerRouter.use(authMiddleware);

async function loadOwnImporter(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  const r = await pool.query('SELECT * FROM importers WHERE id = $1 AND user_id = $2', [
    importerId,
    user.id,
  ]);
  return r.rows[0] ?? null;
}

const GrantSchema = z.object({
  brokerEmail: z.string().email(),
});

// POST /importers/:id/broker-grants — importer grants a broker (by email) access.
brokerRouter.post('/:id/broker-grants', requireRole('importer'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadOwnImporter(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const parse = GrantSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  const brokerUser = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND role = 'broker'`,
    [parse.data.brokerEmail]
  );
  if (brokerUser.rowCount === 0) {
    res.status(404).json({ error: 'no broker account with that email' });
    return;
  }
  const brokerUserId = brokerUser.rows[0]!.id;

  const grant = await pool.query(
    `INSERT INTO broker_importer_grants (broker_user_id, importer_id, granted_by_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (broker_user_id, importer_id)
       DO UPDATE SET revoked_at = NULL, granted_at = now(), granted_by_user_id = $3
     RETURNING *`,
    [brokerUserId, importer.id, user.id]
  );

  await logAudit(user.id, 'broker_access_granted', importer.id, {
    brokerUserId,
    brokerEmail: parse.data.brokerEmail,
  });

  res.status(201).json({ grant: grant.rows[0] });
});

// GET /importers/:id/broker-grants — importer views who currently has access.
brokerRouter.get('/:id/broker-grants', requireRole('importer'), async (req: Request, res: Response) => {
  const importer = await loadOwnImporter(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const r = await pool.query(
    `SELECT g.id, g.broker_user_id, u.email AS broker_email, g.granted_at, g.revoked_at
     FROM broker_importer_grants g JOIN users u ON u.id = g.broker_user_id
     WHERE g.importer_id = $1 AND g.revoked_at IS NULL
     ORDER BY g.granted_at DESC`,
    [importer.id]
  );
  res.json({ grants: r.rows });
});

// DELETE /importers/:id/broker-grants/:grantId — importer revokes a broker's access, any time.
brokerRouter.delete(
  '/:id/broker-grants/:grantId',
  requireRole('importer'),
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const importer = await loadOwnImporter(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const r = await pool.query(
      `UPDATE broker_importer_grants SET revoked_at = now()
       WHERE id = $1 AND importer_id = $2 AND revoked_at IS NULL
       RETURNING *`,
      [req.params.grantId, importer.id]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await logAudit(user.id, 'broker_access_revoked', importer.id, {
      grantId: req.params.grantId,
    });
    res.json({ revoked: true });
  }
);

// GET /importers/broker/mine — a broker's own importer list, scoped strictly
// to active grants. Registered before the ':id' routes below so 'broker'
// never matches as a param value.
brokerRouter.get('/broker/mine', requireRole('broker'), async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const r = await pool.query(
    `SELECT i.* FROM importers i
     JOIN broker_importer_grants g ON g.importer_id = i.id
     WHERE g.broker_user_id = $1 AND g.revoked_at IS NULL AND i.deleted_at IS NULL
     ORDER BY i.legal_name ASC`,
    [user.id]
  );
  res.json({ importers: r.rows });
});

/**
 * Whether `brokerUserId` currently holds an active grant for `importerId`.
 * Exported so importers.ts's loadImporterFor can extend importer-scoped
 * GET routes to brokers without this file and importers.ts importing each
 * other (importers.ts already owns loadImporterFor; this is the one new
 * check it needs to add inline — see the diff there).
 */
export async function hasActiveBrokerGrant(
  brokerUserId: string,
  importerId: string
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM broker_importer_grants
     WHERE broker_user_id = $1 AND importer_id = $2 AND revoked_at IS NULL`,
    [brokerUserId, importerId]
  );
  return (r.rowCount ?? 0) > 0;
}
