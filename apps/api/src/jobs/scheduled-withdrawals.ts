import { processDueScheduledWithdrawals } from '../services/scheduled-withdrawals.js';
import { logger } from '../lib/logger.js';

/**
 * Background scheduler for future-dated staged withdrawals (#994).
 * Checks periodically for due withdrawals, re-validates required collateral,
 * and executes or blocks them accordingly.
 */
export function startScheduledWithdrawalsJob(): void {
  const INTERVAL_MS = 60 * 1000;

  async function tick(): Promise<void> {
    try {
      await processDueScheduledWithdrawals();
    } catch (err) {
      logger.error({ err }, 'scheduled withdrawals tick failed');
    }
  }

  void tick();
  setInterval(tick, INTERVAL_MS);
}
