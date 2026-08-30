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

// Issue #1035 — in-app NPS/feedback survey: prompt cadence, response
// collection, and the admin aggregate trend.
export const npsRouter = Router();
npsRouter.use(authMiddleware);
npsRouter.use(privacyReacceptanceGate);
npsRouter.use(tosReacceptanceGate);

// Minimum days between survey prompts for a given user. Configurable so the
// cadence can be tuned without a code change.
const PROMPT_CADENCE_DAYS = Math.max(1, Number(process.env.NPS_SURVEY_CADENCE_DAYS ?? '30'));

npsRouter.get('/prompt-status', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const row = await pool.query<{ last_shown_at: string }>(
    `SELECT last_shown_at FROM nps_survey_prompts WHERE user_id = $1`,
    [user.id]
  );

  if (row.rowCount === 0) {
    res.json({ shouldShow: true, cadenceDays: PROMPT_CADENCE_DAYS, lastShownAt: null });
    return;
  }

  const lastShownAt = new Date(row.rows[0]!.last_shown_at);
  const dueAt = new Date(lastShownAt.getTime() + PROMPT_CADENCE_DAYS * 24 * 60 * 60 * 1000);
  res.json({
    shouldShow: dueAt.getTime() <= Date.now(),
    cadenceDays: PROMPT_CADENCE_DAYS,
    lastShownAt: lastShownAt.toISOString(),
  });
});

npsRouter.post('/dismiss', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  await pool.query(
    `INSERT INTO nps_survey_prompts (user_id, last_shown_at, last_dismissed_at)
     VALUES ($1, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET last_shown_at = now(), last_dismissed_at = now()`,
    [user.id]
  );
  res.json({ success: true });
});

const RespondSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().max(2000).optional(),
});

npsRouter.post('/respond', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = RespondSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'score (0-10) is required, comment is optional' });
    return;
  }

  const { score, comment } = parse.data;

  await pool.query(
    `INSERT INTO nps_survey_responses (user_id, score, comment) VALUES ($1, $2, $3)`,
    [user.id, score, comment ?? null]
  );
  await pool.query(
    `INSERT INTO nps_survey_prompts (user_id, last_shown_at, last_responded_at)
     VALUES ($1, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET last_shown_at = now(), last_responded_at = now()`,
    [user.id]
  );

  res.status(201).json({ success: true });
});

// GET /nps/admin/trend — weekly NPS trend (promoters% - detractors%) for the admin dashboard.
npsRouter.get('/admin/trend', requireRole('surety_admin'), async (_req: Request, res: Response) => {
  const rows = await pool.query<{
    week_start: string;
    promoters: string;
    passives: string;
    detractors: string;
    total: string;
  }>(
    `SELECT
       date_trunc('week', created_at)::date AS week_start,
       COUNT(*) FILTER (WHERE score >= 9)::text AS promoters,
       COUNT(*) FILTER (WHERE score BETWEEN 7 AND 8)::text AS passives,
       COUNT(*) FILTER (WHERE score <= 6)::text AS detractors,
       COUNT(*)::text AS total
     FROM nps_survey_responses
     WHERE created_at >= now() - INTERVAL '26 weeks'
     GROUP BY 1
     ORDER BY 1 ASC`
  );

  const trend = rows.rows.map((r) => {
    const total = parseInt(r.total, 10);
    const promoters = parseInt(r.promoters, 10);
    const detractors = parseInt(r.detractors, 10);
    const nps = total === 0 ? 0 : Math.round(((promoters - detractors) / total) * 100);
    return {
      weekStart: r.week_start,
      promoters,
      passives: parseInt(r.passives, 10),
      detractors,
      total,
      nps,
    };
  });

  res.json({ trend });
});
