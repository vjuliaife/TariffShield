import { pool, createNotification, logAudit } from '../db.js';
import { enqueueTxSubmit } from '../queue.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { logger } from '../lib/logger.js';

export function computeNextRunAt(cadence: 'weekly' | 'monthly', fromDate: Date = new Date()): Date {
  const next = new Date(fromDate.getTime());
  if (cadence === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else {
    next.setDate(next.getDate() + 30);
  }
  return next;
}

export interface ScheduledDepositResult {
  scheduleId: string;
  importerId: string;
  status: 'success' | 'failed' | 'skipped';
  jobId?: string;
  error?: string;
}

/**
 * Triggers deposit_collateral via the existing deposit submission path (#993).
 * Re-validates KYC status and fund capability before executing.
 * Generates notification on failure (insufficient funds) or success.
 */
export async function processScheduledDeposits(): Promise<ScheduledDepositResult[]> {
  const results: ScheduledDepositResult[] = [];

  const dueQuery = await pool.query<{
    id: string;
    importer_id: string;
    user_id: string;
    cadence: 'weekly' | 'monthly';
    amount_stroops: string;
    bucket: 'collateral' | 'reserve';
    next_run_at: Date;
    stellar_address: string;
    stellar_secret_encrypted: string;
    kyc_status: string;
  }>(
    `SELECT s.id, s.importer_id, s.user_id, s.cadence, s.amount_stroops::text AS amount_stroops,
            s.bucket, s.next_run_at, i.stellar_address, i.stellar_secret_encrypted, i.kyc_status
     FROM deposit_schedules s
     JOIN importers i ON i.id = s.importer_id
     WHERE s.status = 'active' AND s.next_run_at <= now()
     ORDER BY s.next_run_at ASC`
  );

  for (const schedule of dueQuery.rows) {
    if (schedule.kyc_status !== 'approved') {
      const errMsg = 'KYC approval required before recurring collateral deposits';
      await pool.query(
        `INSERT INTO deposit_schedule_executions (schedule_id, importer_id, amount_stroops, bucket, status, error_message)
         VALUES ($1, $2, $3, $4, 'skipped', $5)`,
        [schedule.id, schedule.importer_id, schedule.amount_stroops, schedule.bucket, errMsg]
      );
      results.push({
        scheduleId: schedule.id,
        importerId: schedule.importer_id,
        status: 'skipped',
        error: errMsg,
      });
      continue;
    }

    try {
      // Trigger deposit_collateral via the existing deposit path
      const jobId = await enqueueTxSubmit({
        method: 'deposit',
        importerId: schedule.importer_id,
        keypairSecret: schedule.stellar_secret_encrypted,
        args: {
          bucket: schedule.bucket,
          importerAddress: schedule.stellar_address,
          sourceAddress: schedule.stellar_address,
          amountStroops: schedule.amount_stroops,
        },
      });

      const nextRun = computeNextRunAt(schedule.cadence, new Date());

      await pool.query(
        `INSERT INTO deposit_schedule_executions (schedule_id, importer_id, amount_stroops, bucket, status, job_id)
         VALUES ($1, $2, $3, $4, 'success', $5)`,
        [schedule.id, schedule.importer_id, schedule.amount_stroops, schedule.bucket, jobId]
      );

      await pool.query(
        `UPDATE deposit_schedules
         SET last_run_at = now(), next_run_at = $1, last_error = NULL, updated_at = now()
         WHERE id = $2`,
        [nextRun, schedule.id]
      );

      await createNotification(
        schedule.user_id,
        NOTIFICATION_KINDS.SCHEDULED_DEPOSIT_SUCCESS,
        `Scheduled ${schedule.cadence} deposit of ${schedule.amount_stroops} stroops submitted successfully.`
      );

      results.push({
        scheduleId: schedule.id,
        importerId: schedule.importer_id,
        status: 'success',
        jobId,
      });
    } catch (err: any) {
      const errorMessage = err?.message || 'Deposit submission failed: insufficient funds or network error';
      logger.error({ err, scheduleId: schedule.id }, 'scheduled deposit failed');

      await pool.query(
        `INSERT INTO deposit_schedule_executions (schedule_id, importer_id, amount_stroops, bucket, status, error_message)
         VALUES ($1, $2, $3, $4, 'failed', $5)`,
        [schedule.id, schedule.importer_id, schedule.amount_stroops, schedule.bucket, errorMessage]
      );

      await pool.query(
        `UPDATE deposit_schedules
         SET last_run_at = now(), last_error = $1, updated_at = now()
         WHERE id = $2`,
        [errorMessage, schedule.id]
      );

      // Failed scheduled deposits (insufficient funds) generate a notification (#993 AC 4)
      await createNotification(
        schedule.user_id,
        NOTIFICATION_KINDS.SCHEDULED_DEPOSIT_FAILED,
        `Scheduled deposit of ${schedule.amount_stroops} stroops failed: ${errorMessage}. Please check your account balance.`
      );

      results.push({
        scheduleId: schedule.id,
        importerId: schedule.importer_id,
        status: 'failed',
        error: errorMessage,
      });
    }
  }

  return results;
}
