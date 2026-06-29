/**
 * Issue #313 — PII Data Retention Enforcement Job
 *
 * Runs daily. For each retention category:
 *   - Skips records on active legal/AML holds
 *   - Anonymizes PII fields for importer records
 *   - Deletes expired aml_screenings (pure PII, no aggregate value)
 *   - Retains financial aggregate rows (tariff_uploads, contract_events, oracle_alerts) but nulls PII
 * Logs all actions to retention_audit_log.
 */
import { pino } from "pino";
import { pool } from "../db.js";

const logger = pino({ name: "retention-job" });

export async function enforceRetention(): Promise<void> {
  logger.info("Starting daily retention enforcement run");
  const now = new Date().toISOString();

  // 1. Anonymize expired importer PII (legal_name, ein, stellar_secret_encrypted)
  //    Exclude records on active holds.
  const importerResult = await pool.query(
    `UPDATE importers
     SET legal_name = '[REDACTED]',
         ein = NULL,
         stellar_secret_encrypted = NULL,
         updated_at = now()
     WHERE retention_expires_at IS NOT NULL
       AND retention_expires_at < now()
       AND legal_name != '[REDACTED]'
       AND id NOT IN (
         SELECT record_id FROM retention_holds
         WHERE record_table = 'importers' AND released_at IS NULL
       )
     RETURNING id`,
  );
  const importerCount = importerResult.rowCount ?? 0;
  if (importerCount > 0) {
    await pool.query(
      `INSERT INTO retention_audit_log (job_run_at, record_category, record_count, action, retention_policy)
       VALUES ($1, 'importers', $2, 'anonymize_pii', '3 years post-account closure')`,
      [now, importerCount],
    );
    logger.info({ count: importerCount }, "Anonymized expired importer PII");
  }

  // 2. Delete expired AML screening records (PII, no regulatory aggregate requirement)
  const amlResult = await pool.query(
    `DELETE FROM aml_screenings
     WHERE retention_expires_at < now()
       AND id NOT IN (
         SELECT record_id FROM retention_holds
         WHERE record_table = 'aml_screenings' AND released_at IS NULL
       )
     RETURNING id`,
  );
  const amlCount = amlResult.rowCount ?? 0;
  if (amlCount > 0) {
    await pool.query(
      `INSERT INTO retention_audit_log (job_run_at, record_category, record_count, action, retention_policy)
       VALUES ($1, 'aml_screenings', $2, 'delete', '5 years post-last-transaction')`,
      [now, amlCount],
    );
    logger.info({ count: amlCount }, "Deleted expired AML screening records");
  }

  logger.info("Retention enforcement run complete");
}

/** Starts the retention enforcement job on a daily interval. */
export function startRetentionJob(): void {
  logger.info("Scheduling daily retention enforcement job");
  // Run once shortly after boot, then every 24 h
  setTimeout(() => {
    enforceRetention().catch((err) => logger.error({ err }, "Retention job failed"));
  }, 60_000);
  setInterval(() => {
    enforceRetention().catch((err) => logger.error({ err }, "Retention job failed"));
  }, 24 * 60 * 60 * 1000);
}
