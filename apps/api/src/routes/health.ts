import { Router } from 'express';
import { ping, getPoolStats } from '../db.js';
import { pingRpc } from '../stellar.js';
import { pingRedis } from '../queue.js';
import { env, isProduction } from '../config/env.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface HealthDependencies {
  ping: typeof ping;
  pingRpc: typeof pingRpc;
  pingRedis: typeof pingRedis;
}

export function createHealthRouter(dependencies: HealthDependencies = { ping, pingRpc, pingRedis }) {
  const router = Router();

  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {
    /* intentionally ignored — fall back to the "unknown" version already set above */
  }

  router.get('/', async (_req, res) => {
    const checks = {
      db: 'connected',
      soroban: 'ok',
      redis: 'connected',
    };
    let hasError = false;

    try {
      await dependencies.ping();
    } catch (_err) {
      checks.db = 'failed';
      hasError = true;
    }

    try {
      await dependencies.pingRpc();
    } catch (_err) {
      checks.soroban = 'failed';
      hasError = true;
    }

    try {
      await dependencies.pingRedis();
    } catch (_err) {
      checks.redis = 'failed';
      hasError = true;
    }

    if (hasError) {
      res.status(503).json({
        status: 'degraded',
        version,
        ...checks,
      });
    } else {
      res.json({
        status: 'ok',
        version,
        ...checks,
        contractId: env.TARIFF_SHIELD_CONTRACT_ID,
        network: env.STELLAR_NETWORK,
        env: isProduction ? 'production' : 'development',
      });
    }
  });

  // #241 — dedicated DB health check with pool stats, for monitoring
  // connection saturation independently of the aggregate /health checks above.
  router.get('/db', async (_req, res) => {
    try {
      await dependencies.ping();
      res.json({
        status: 'ok',
        pool: getPoolStats(),
      });
    } catch (_err) {
      res.status(503).json({
        status: 'degraded',
        db: 'failed',
        pool: getPoolStats(),
      });
    }
  });

  router.get('/live', (_req, res) => {
    res.status(200).type('text/plain').send('OK');
  });

  router.get('/ready', async (_req, res) => {
    try {
      await Promise.all([dependencies.ping(), dependencies.pingRpc(), dependencies.pingRedis()]);
      res.status(200).type('text/plain').send('OK');
    } catch (_err) {
      res.status(503).type('text/plain').send('Service Unavailable');
    }
  });

  return router;
}

export const healthRouter = createHealthRouter();
