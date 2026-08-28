import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const upgradeSubscriptionsRouter = Router();
upgradeSubscriptionsRouter.use(authMiddleware);
upgradeSubscriptionsRouter.use(privacyReacceptanceGate);
upgradeSubscriptionsRouter.use(tosReacceptanceGate);

// POST /upgrade-subscriptions — subscribe to upgrade proposal notifications
upgradeSubscriptionsRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ surety_id: z.string().uuid() }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'surety_id is required' });
    return;
  }

  const { surety_id } = parse.data;

  const existing = await pool.query(
    `SELECT id, is_active FROM upgrade_subscriptions
     WHERE user_id = $1 AND surety_id = $2`,
    [user.id, surety_id]
  );

  if (existing.rowCount && existing.rows[0]?.is_active) {
    res.json({ success: true, message: 'already subscribed' });
    return;
  }

  if (existing.rowCount && !existing.rows[0]?.is_active) {
    await pool.query(
      `UPDATE upgrade_subscriptions SET is_active = TRUE, updated_at = now()
       WHERE user_id = $1 AND surety_id = $2`,
      [user.id, surety_id]
    );
  } else {
    await pool.query(
      `INSERT INTO upgrade_subscriptions (user_id, surety_id)
       VALUES ($1, $2)`,
      [user.id, surety_id]
    );
  }

  res.json({ success: true });
});

// DELETE /upgrade-subscriptions/:suretyId — unsubscribe from upgrade proposal notifications
upgradeSubscriptionsRouter.delete('/:suretyId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const suretyId = String(req.params.suretyId);

  await pool.query(
    `UPDATE upgrade_subscriptions SET is_active = FALSE, updated_at = now()
     WHERE user_id = $1 AND surety_id = $2`,
    [user.id, suretyId]
  );

  res.json({ success: true });
});

// GET /upgrade-subscriptions — list user's active subscriptions
upgradeSubscriptionsRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const result = await pool.query(
    `SELECT id, surety_id, is_active, created_at, updated_at
     FROM upgrade_subscriptions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [user.id]
  );

  res.json({ subscriptions: result.rows });
});

// GET /upgrade-subscriptions/history — list notification history for subscribed sureties
upgradeSubscriptionsRouter.get('/history', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const result = await pool.query(
    `SELECT unh.id, unh.proposal_id, unh.event_type, unh.proposer,
            unh.approval_count, unh.wasm_hash, unh.created_at
     FROM upgrade_notification_history unh
     JOIN upgrade_subscriptions us ON us.surety_id = unh.surety_id
     WHERE us.user_id = $1 AND us.is_active = TRUE
     ORDER BY unh.created_at DESC
     LIMIT 50`,
    [user.id]
  );

  res.json({ history: result.rows });
});
