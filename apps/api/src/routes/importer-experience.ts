import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  buildOnboardingSteps,
  hasValidParticipationTotal,
} from '../services/importer-experience.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  requireRole,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const importerExperienceRouter = Router();
importerExperienceRouter.use(authMiddleware, privacyReacceptanceGate, tosReacceptanceGate);

const WIDGETS = ['health', 'balance', 'yield', 'activity'] as const;
const PreferencesSchema = z.object({
  widgetOrder: z
    .array(z.enum(WIDGETS))
    .length(WIDGETS.length)
    .refine((items) => new Set(items).size === WIDGETS.length),
  hiddenWidgets: z.array(z.enum(WIDGETS)).max(WIDGETS.length),
});

importerExperienceRouter.get(
  '/dashboard-preferences',
  requireRole('importer'),
  async (req, res) => {
    const { id } = (req as AuthedRequest).user;
    const result = await pool.query(
      `INSERT INTO importer_dashboard_preferences (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING widget_order, hidden_widgets`,
      [id]
    );
    res.json({
      widgetOrder: result.rows[0]!.widget_order,
      hiddenWidgets: result.rows[0]!.hidden_widgets,
    });
  }
);

importerExperienceRouter.put(
  '/dashboard-preferences',
  requireRole('importer'),
  async (req, res) => {
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid dashboard preferences', details: parsed.error.issues });
      return;
    }
    const { id } = (req as AuthedRequest).user;
    const { widgetOrder, hiddenWidgets } = parsed.data;
    const result = await pool.query(
      `INSERT INTO importer_dashboard_preferences (user_id, widget_order, hidden_widgets)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET widget_order = EXCLUDED.widget_order,
       hidden_widgets = EXCLUDED.hidden_widgets, updated_at = now()
     RETURNING widget_order, hidden_widgets`,
      [id, widgetOrder, [...new Set(hiddenWidgets)]]
    );
    res.json({
      widgetOrder: result.rows[0]!.widget_order,
      hiddenWidgets: result.rows[0]!.hidden_widgets,
    });
  }
);

importerExperienceRouter.get('/onboarding-checklist', requireRole('importer'), async (req, res) => {
  const { id } = (req as AuthedRequest).user;
  const result = await pool.query(
    `SELECT i.id, i.kyc_status,
       EXISTS (SELECT 1 FROM contract_events ce WHERE ce.importer_id = i.id
         AND ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve')) AS has_deposit,
       EXISTS (SELECT 1 FROM tariff_uploads tu WHERE tu.importer_id = i.id) AS has_tariff_upload,
       pref.onboarding_dismissed_at
     FROM users u LEFT JOIN importers i ON i.user_id = u.id
     LEFT JOIN importer_dashboard_preferences pref ON pref.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
  const row = result.rows[0]!;
  const steps = buildOnboardingSteps(
    row.kyc_status === 'approved',
    Boolean(row.has_deposit),
    Boolean(row.has_tariff_upload)
  );
  res.json({
    steps,
    complete: steps.every((step) => step.complete),
    dismissed: Boolean(row.onboarding_dismissed_at),
  });
});

importerExperienceRouter.post(
  '/onboarding-checklist/dismiss',
  requireRole('importer'),
  async (req, res) => {
    const { id } = (req as AuthedRequest).user;
    await pool.query(
      `INSERT INTO importer_dashboard_preferences (user_id, onboarding_dismissed_at)
     VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE
     SET onboarding_dismissed_at = now(), updated_at = now()`,
      [id]
    );
    res.json({ success: true });
  }
);

importerExperienceRouter.get('/referrals', requireRole('importer'), async (req, res) => {
  const user = (req as AuthedRequest).user;
  const [profile, referrals] = await Promise.all([
    pool.query<{ referral_code: string }>('SELECT referral_code FROM users WHERE id = $1', [
      user.id,
    ]),
    pool.query(
      `SELECT r.id, r.status, r.created_at, r.converted_at, u.email
     FROM importer_referrals r JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = $1 ORDER BY r.created_at DESC`,
      [user.id]
    ),
  ]);
  res.json({ code: profile.rows[0]!.referral_code, referrals: referrals.rows });
});

importerExperienceRouter.get(
  '/referrals/report',
  requireRole('surety_admin'),
  async (_req, res) => {
    const report = await pool.query(
      `SELECT r.referral_code, r.status, r.created_at, r.converted_at,
       referrer.id AS referrer_id, referrer.email AS referrer_email,
       referred.id AS referred_id, referred.email AS referred_email
     FROM importer_referrals r JOIN users referrer ON referrer.id = r.referrer_user_id
     JOIN users referred ON referred.id = r.referred_user_id
     ORDER BY r.created_at DESC`
    );
    res.json({ referrals: report.rows });
  }
);

const ParticipantsSchema = z
  .object({
    participants: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(160),
          reference: z.string().trim().min(1).max(160),
          percentage: z.number().positive().max(100),
        })
      )
      .min(1)
      .max(20),
  })
  .superRefine(({ participants }, ctx) => {
    if (
      new Set(participants.map((item) => item.reference.toLowerCase())).size !== participants.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'participant references must be unique',
      });
    }
    if (!hasValidParticipationTotal(participants)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'participation percentages must total exactly 100%',
      });
    }
  });

async function canAccessImporter(importerId: string, userId: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM importers WHERE id = $1 AND user_id = $2', [
    importerId,
    userId,
  ]);
  return Boolean(result.rowCount);
}

importerExperienceRouter.get(
  '/importers/:importerId/co-sureties',
  requireRole('importer'),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await canAccessImporter(req.params.importerId!, user.id))) {
      res.status(404).json({ error: 'importer not found' });
      return;
    }
    const result = await pool.query(
      `SELECT id, participant_name AS name, participant_reference AS reference,
       participation_bps AS participationBps, created_at
     FROM importer_co_sureties WHERE importer_id = $1 ORDER BY created_at, id`,
      [req.params.importerId]
    );
    res.json({ participants: result.rows });
  }
);

importerExperienceRouter.put(
  '/importers/:importerId/co-sureties',
  requireRole('importer'),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await canAccessImporter(req.params.importerId!, user.id))) {
      res.status(404).json({ error: 'importer not found' });
      return;
    }
    const parsed = ParticipantsSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid co-surety participation', details: parsed.error.issues });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM importer_co_sureties WHERE importer_id = $1', [
        req.params.importerId,
      ]);
      for (const participant of parsed.data.participants) {
        await client.query(
          `INSERT INTO importer_co_sureties (importer_id, participant_name, participant_reference, participation_bps)
         VALUES ($1, $2, $3, $4)`,
          [
            req.params.importerId,
            participant.name,
            participant.reference,
            Math.round(participant.percentage * 100),
          ]
        );
      }
      await client.query('COMMIT');
      res.json({ participants: parsed.data.participants });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
);

importerExperienceRouter.get(
  '/co-surety-exposure',
  requireRole('surety_admin'),
  async (_req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT cs.participant_name AS name, cs.participant_reference AS reference,
       COUNT(DISTINCT cs.importer_id)::int AS bond_count,
       SUM(COALESCE(br.bond_amount, 0) * cs.participation_bps / 10000)::numeric AS exposure
     FROM importer_co_sureties cs
     JOIN importers i ON i.id = cs.importer_id
     LEFT JOIN LATERAL (
       SELECT bond_amount FROM bond_records WHERE importer_id = i.id ORDER BY created_at DESC LIMIT 1
     ) br ON true
     GROUP BY cs.participant_name, cs.participant_reference
     ORDER BY exposure DESC`
    );
    res.json({ participants: result.rows });
  }
);
