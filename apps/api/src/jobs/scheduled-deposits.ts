import { processScheduledDeposits } from '../services/deposit-schedules.js';
import { logger } from '../lib/logger.js';

/**
 * Scheduled job for recurring collateral deposits (#993).
 * Runs on a periodic cadence and triggers due deposits via the existing deposit path.
 */
export function startScheduledDepositsJob(): void {
  // Check every 60 seconds
  const INTERVAL_MS = 60 * 1000;

  async function tick(): Promise<void> {
    try {
      await processScheduledDeposits();
    } catch (err) {
      logger.error({ err }, 'scheduled deposits tick failed');
    }
  }

  void tick();
  setInterval(tick, INTERVAL_MS);
}
