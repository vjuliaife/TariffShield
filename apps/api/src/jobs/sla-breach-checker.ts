import { pool } from '../db.js';
import { logger } from '../lib/logger.js';

/**
 * Periodic job that checks for SLA breaches. Runs every 5 minutes.
 *
 * Issue #1042: Configurable business hours and SLA tracking.
 * Marks items as breached when their deadline has passed and they haven't been resolved.
 */
export function startSlaBreachChecker(): void {
  const INTERVAL_MS = 5 * 60 * 1000;

  async function checkForBreaches(): Promise<void> {
    try {
      // Mark unresolved items whose deadline has passed as breached
      const result = await pool.query(
        `UPDATE sla_tracking
         SET is_breached = TRUE, updated_at = now()
         WHERE resolved_at IS NULL
           AND is_breached = FALSE
           AND deadline < now()
         RETURNING id, item_type, item_id, deadline`
      );

      if (result.rowCount && result.rowCount > 0) {
        logger.info({ count: result.rowCount }, 'SLA breaches detected');

        // Create notifications for breached items
        for (const row of result.rows) {
          await notifySlaBreach(row.surety_id, row.item_type, row.item_id, row.deadline);
        }
      }
    } catch (err) {
      logger.error({ err }, 'SLA breach check failed');
    }
  }

  // Run immediately, then on interval
  checkForBreaches();
  setInterval(checkForBreaches, INTERVAL_MS);
}

async function notifySlaBreach(
  suretyId: string,
  itemType: string,
  itemId: string,
  deadline: Date
): Promise<void> {
  try {
    // Import createNotification dynamically to avoid circular deps
    const { createNotification } = await import('../db.js');

    // Get the surety admin user for this tenant
    const result = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'surety_admin'`,
      [suretyId]
    );

    if (result.rowCount) {
      const message = `SLA breach: ${itemType.replace(/_/g, ' ')} ${itemId.slice(0, 8)}… has exceeded its ${deadline.toISOString().split('T')[0]} deadline.`;
      await createNotification(suretyId, 'sla_breach', message);
    }
  } catch (err) {
    logger.error({ err, suretyId, itemType, itemId }, 'failed to send SLA breach notification');
  }
}
