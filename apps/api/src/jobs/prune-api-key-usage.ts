import { logger } from '../lib/logger.js';
import { pruneApiKeyUsage } from '../services/api-key-usage.js';

/**
 * Issue #1043 — keep `api_key_usage` bounded. Historical usage is retained for
 * 30 days; older minute buckets are swept daily.
 */
export function startApiKeyUsagePruneScheduler(): void {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  async function sweep(): Promise<void> {
    try {
      const deleted = await pruneApiKeyUsage(30);
      if (deleted > 0) logger.info({ deleted }, 'pruned expired api_key_usage rows');
    } catch (err) {
      logger.error({ err }, 'api_key_usage prune failed');
    }
  }

  sweep();
  setInterval(sweep, INTERVAL_MS);
}
