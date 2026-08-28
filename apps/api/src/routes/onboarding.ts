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
import { unsubscribeFromOnboardingDrip } from '../services/onboarding-drip.js';

/**
 * Issue #1044 — onboarding drip campaign endpoints.
 *
 * GET  /onboarding/drip                    → the caller's enrollment + send log
 * POST /onboarding/drip/unsubscribe        → opt out (transactional notifications unaffected)
 * GET  /onboarding/drip/steps              → sequence config (surety_admin)
 * PUT  /onboarding/drip/steps/:stepKey     → edit a step (surety_admin)
 */
export const onboardingRouter = Router();
onboardingRouter.use(authMiddleware);
onboardingRouter.use(privacyReacceptanceGate);
onboardingRouter.use(tosReacceptanceGate);

onboardingRouter.get('/drip', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const enrollment = await pool.query(
    `SELECT id, enrolled_at, completed_at, unsubscribed_at
     FROM onboarding_drip_enrollments WHERE user_id = $1`,
    [user.id]
  );
  if (enrollment.rowCount === 0) {
    res.json({ enrolled: false, sends: [] });
    return;
  }
  const enr = enrollment.rows[0]!;
  const sends = await pool.query(
    `SELECT s.step_key, s.status, s.sent_at, st.subject
     FROM onboarding_drip_sends s
     LEFT JOIN onboarding_drip_steps st ON st.step_key = s.step_key
     WHERE s.enrollment_id = $1
     ORDER BY s.sent_at ASC`,
    [enr.id]
  );
  res.json({
    enrolled: true,
    enrolledAt: enr.enrolled_at,
    completedAt: enr.completed_at,
    unsubscribedAt: enr.unsubscribed_at,
    sends: sends.rows,
  });
});

onboardingRouter.post('/drip/unsubscribe', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  await unsubscribeFromOnboardingDrip(user.id);
  res.json({ success: true });
});

onboardingRouter.get(
  '/drip/steps',
  requireRole('surety_admin'),
  async (_req: Request, res: Response) => {
    const steps = await pool.query(
      `SELECT step_key, position, subject, body, delay_hours, completion_check, is_active, updated_at
       FROM onboarding_drip_steps
       ORDER BY position ASC`
    );
    res.json({ steps: steps.rows });
  }
);

const StepUpdateSchema = z
  .object({
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(4000).optional(),
    delay_hours: z.number().int().min(0).max(8760).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

onboardingRouter.put(
  '/drip/steps/:stepKey',
  requireRole('surety_admin'),
  async (req: Request, res: Response) => {
    const parse = StepUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', details: parse.error.issues });
      return;
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(parse.data)) {
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(v);
    }
    vals.push(String(req.params.stepKey));
    const updated = await pool.query(
      `UPDATE onboarding_drip_steps
       SET ${sets.join(', ')}, updated_at = now()
       WHERE step_key = $${vals.length}
       RETURNING step_key, position, subject, body, delay_hours, completion_check, is_active, updated_at`,
      vals
    );
    if (updated.rowCount === 0) {
      res.status(404).json({ error: 'step not found' });
      return;
    }
    res.json({ step: updated.rows[0] });
  }
);
