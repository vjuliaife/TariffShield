import { Router } from 'express';
import { ping, getPoolStats } from '../db.js';
import { pingRpc } from '../stellar.js';
import { pingRedis } from '../queue.js';
import { env, isProduction } from '../config/env.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export const healthRouter = Router();

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  version = pkg.version || 'unknown';
} catch {
  /* intentionally ignored — fall back to the "unknown" version already set above */
}

healthRouter.get('/', async (_req, res) => {
  const checks = {
    db: 'connected',
    soroban: 'ok',
    redis: 'connected',
  };
  let hasError = false;

  try {
    await ping();
  } catch (_err) {
    checks.db = 'failed';
    hasError = true;
  }

  try {
    await pingRpc();
  } catch (_err) {
    checks.soroban = 'failed';
    hasError = true;
  }

  try {
    await pingRedis();
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
healthRouter.get('/db', async (_req, res) => {
  try {
    await ping();
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

// #973 — liveness/readiness probes return JSON with a `status` field, matching
// the shape of GET / and GET /db. Probes that only look at the status code
// (Kubernetes, Render, load balancers) are unaffected.
healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req, res) => {
  try {
    await Promise.all([ping(), pingRpc(), pingRedis()]);
    res.status(200).json({ status: 'ok' });
  } catch (_err) {
    res.status(503).json({ status: 'degraded' });
  }
});
