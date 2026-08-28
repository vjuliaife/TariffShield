import { pool, createNotification } from '../db.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { logger } from '../lib/logger.js';

/**
 * Issue #1044 — automated onboarding drip campaign.
 *
 * On signup an importer is enrolled (see routes/auth.ts). A scheduler walks the
 * `onboarding_drip_steps` sequence: when a step comes due it is either sent
 * (as an in-app notification — the platform's delivery primitive, see
 * services/upgrade-notifications.ts) or skipped if the importer has already
 * done the thing it nudges toward. Once every active step is resolved the
 * enrollment is marked complete and no longer processed. Importers can
 * unsubscribe without affecting transactional notifications.
 */

export type CompletionCheck = 'kyc' | 'deposit' | 'tariff' | 'none';

interface DripStep {
  step_key: string;
  position: number;
  subject: string;
  body: string;
  delay_hours: number;
  completion_check: CompletionCheck;
}

export async function enrollInOnboardingDrip(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO onboarding_drip_enrollments (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

export async function unsubscribeFromOnboardingDrip(userId: string): Promise<void> {
  await pool.query(
    `UPDATE onboarding_drip_enrollments
     SET unsubscribed_at = now()
     WHERE user_id = $1 AND unsubscribed_at IS NULL`,
    [userId]
  );
}

/** Whether the importer for `userId` has already performed the step's target action. */
export async function hasCompletedAction(
  userId: string,
  check: CompletionCheck
): Promise<boolean> {
  if (check === 'none') return false;
  if (check === 'kyc') {
    const r = await pool.query(
      `SELECT 1 FROM importers WHERE user_id = $1 AND kyc_status = 'approved' LIMIT 1`,
      [userId]
    );
    return (r.rowCount ?? 0) > 0;
  }
  if (check === 'deposit') {
    const r = await pool.query(
      `SELECT 1
       FROM contract_events ce
       JOIN importers i ON i.id = ce.importer_id
       WHERE i.user_id = $1
         AND ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve', 'auto_top_up')
       LIMIT 1`,
      [userId]
    );
    return (r.rowCount ?? 0) > 0;
  }
  // tariff
  const r = await pool.query(
    `SELECT 1 FROM tariff_uploads t
     JOIN importers i ON i.id = t.importer_id
     WHERE i.user_id = $1 LIMIT 1`,
    [userId]
  );
  return (r.rowCount ?? 0) > 0;
}

async function activeSteps(): Promise<DripStep[]> {
  const r = await pool.query<DripStep>(
    `SELECT step_key, position, subject, body, delay_hours, completion_check
     FROM onboarding_drip_steps
     WHERE is_active = TRUE
     ORDER BY position ASC`
  );
  return r.rows;
}

interface OpenEnrollment {
  id: string;
  user_id: string;
  enrolled_at: string;
}

/**
 * One scheduler pass. For each open enrollment, resolve at most one due step
 * (send or skip). Marks the enrollment complete when every active step has a
 * send row.
 */
export async function processOnboardingDrip(): Promise<void> {
  const steps = await activeSteps();
  if (steps.length === 0) return;

  const enrollments = await pool.query<OpenEnrollment>(
    `SELECT id, user_id, enrolled_at
     FROM onboarding_drip_enrollments
     WHERE completed_at IS NULL AND unsubscribed_at IS NULL`
  );

  for (const enr of enrollments.rows) {
    try {
      const sentRows = await pool.query<{ step_key: string }>(
        `SELECT step_key FROM onboarding_drip_sends WHERE enrollment_id = $1`,
        [enr.id]
      );
      const resolved = new Set(sentRows.rows.map((r) => r.step_key));

      if (steps.every((s) => resolved.has(s.step_key))) {
        await pool.query(
          `UPDATE onboarding_drip_enrollments SET completed_at = now() WHERE id = $1`,
          [enr.id]
        );
        continue;
      }

      const enrolledAt = new Date(enr.enrolled_at).getTime();
      const now = Date.now();

      for (const step of steps) {
        if (resolved.has(step.step_key)) continue;
        const dueAt = enrolledAt + step.delay_hours * 3_600_000;
        if (now < dueAt) break; // steps are sequential — wait for this one

        const done = await hasCompletedAction(enr.user_id, step.completion_check);
        if (done) {
          await recordSend(enr.id, step.step_key, 'skipped');
        } else {
          await createNotification(
            enr.user_id,
            NOTIFICATION_KINDS.ONBOARDING_DRIP,
            `${step.subject} — ${step.body}`
          );
          await recordSend(enr.id, step.step_key, 'sent');
        }
        break; // one step per enrollment per pass
      }
    } catch (err) {
      logger.error({ err, enrollmentId: enr.id }, 'onboarding drip step failed');
    }
  }
}

async function recordSend(
  enrollmentId: string,
  stepKey: string,
  status: 'sent' | 'skipped'
): Promise<void> {
  await pool.query(
    `INSERT INTO onboarding_drip_sends (enrollment_id, step_key, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (enrollment_id, step_key) DO NOTHING`,
    [enrollmentId, stepKey, status]
  );
}

export function startOnboardingDripScheduler(): void {
  const INTERVAL_MS = 15 * 60 * 1000;
  async function tick(): Promise<void> {
    try {
      await processOnboardingDrip();
    } catch (err) {
      logger.error({ err }, 'onboarding drip scheduler pass failed');
    }
  }
  tick();
  setInterval(tick, INTERVAL_MS);
}
