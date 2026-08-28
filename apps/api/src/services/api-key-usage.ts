import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db.js';
import { logger } from '../lib/logger.js';

/**
 * Issue #1043 — API key request metering + rate-limit visibility.
 *
 * There is no API-key auth gate in front of the REST API today; this module
 * only *meters* traffic that presents an `X-Api-Key` header (matching a row in
 * `api_keys`) so integrators get a usage dashboard. It never rejects a
 * request — enforcement, if added later, is a separate concern.
 */

export const ENDPOINT_CATEGORIES = [
  'importers',
  'bonds',
  'compliance',
  'kyc',
  'notifications',
  'admin',
  'auth',
  'other',
] as const;

export type EndpointCategory = (typeof ENDPOINT_CATEGORIES)[number];

/** First path segment → coarse category for the usage breakdown. */
export function categorizePath(path: string): EndpointCategory {
  const seg = path.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  switch (seg) {
    case 'importers':
      return 'importers';
    case 'bonds':
    case 'bond-annotations':
    case 'bond-signatures':
      return 'bonds';
    case 'compliance':
    case 'regulatory':
    case 'privacy':
    case 'account':
      return 'compliance';
    case 'kyc':
      return 'kyc';
    case 'notifications':
    case 'upgrade-subscriptions':
      return 'notifications';
    case 'admin':
      return 'admin';
    case 'auth':
      return 'auth';
    default:
      return 'other';
  }
}

function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Truncate to the start of the minute the timestamp falls in. */
function minuteWindow(when: Date): Date {
  const d = new Date(when);
  d.setSeconds(0, 0);
  return d;
}

/**
 * Increment the request counter for a key in the current minute bucket.
 * Best-effort: a metering failure must never affect the request itself.
 */
export async function recordApiKeyUsage(
  apiKeyId: string,
  category: EndpointCategory,
  when: Date = new Date()
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO api_key_usage (api_key_id, endpoint_category, window_start, request_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (api_key_id, endpoint_category, window_start)
       DO UPDATE SET request_count = api_key_usage.request_count + 1`,
      [apiKeyId, category, minuteWindow(when)]
    );
    await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [apiKeyId]);
  } catch (err) {
    logger.warn({ err, apiKeyId }, 'api key usage metering failed');
  }
}

interface KeyRow {
  id: string;
  rate_limit_per_min: number | null;
}

async function resolveApiKey(rawKey: string): Promise<KeyRow | null> {
  const res = await pool.query<KeyRow>(
    `SELECT id, rate_limit_per_min FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [hashApiKey(rawKey)]
  );
  return res.rows[0] ?? null;
}

/**
 * Express middleware: meter requests that carry a recognised API key.
 * Mounted globally; a no-op for browser/session traffic.
 */
export function apiKeyUsageMeter(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.header('x-api-key');
  if (!rawKey) {
    next();
    return;
  }
  const category = categorizePath(req.path);
  res.on('finish', () => {
    void (async () => {
      const key = await resolveApiKey(rawKey).catch(() => null);
      if (key) await recordApiKeyUsage(key.id, category);
    })();
  });
  next();
}

export interface UsageBucket {
  windowStart: string;
  requestCount: number;
}

export interface ApiKeyUsageSummary {
  apiKeyId: string | null;
  rateLimitPerMin: number | null;
  currentMinuteCount: number;
  remaining: number | null;
  /** true when the current minute is at or above 80% of the configured limit. */
  approachingLimit: boolean;
  last24hByHour: UsageBucket[];
  last30dByDay: UsageBucket[];
  last24hByCategory: { category: string; requestCount: number }[];
}

const APPROACHING_LIMIT_RATIO = 0.8;

/**
 * Usage rollup for a single key, or — when `apiKeyId` is null — aggregated
 * across every key id in `keyIds` (the caller's whole key set).
 */
export async function getApiKeyUsageSummary(opts: {
  apiKeyId: string | null;
  keyIds: string[];
  rateLimitPerMin: number | null;
}): Promise<ApiKeyUsageSummary> {
  const { apiKeyId, keyIds, rateLimitPerMin } = opts;
  const ids = apiKeyId ? [apiKeyId] : keyIds;

  const empty: ApiKeyUsageSummary = {
    apiKeyId,
    rateLimitPerMin,
    currentMinuteCount: 0,
    remaining: rateLimitPerMin,
    approachingLimit: false,
    last24hByHour: [],
    last30dByDay: [],
    last24hByCategory: [],
  };
  if (ids.length === 0) return empty;

  const [byHour, byDay, byCategory, currentMinute] = await Promise.all([
    pool.query(
      `SELECT date_trunc('hour', window_start) AS bucket, SUM(request_count)::int AS count
       FROM api_key_usage
       WHERE api_key_id = ANY($1) AND window_start >= now() - interval '24 hours'
       GROUP BY bucket ORDER BY bucket`,
      [ids]
    ),
    pool.query(
      `SELECT date_trunc('day', window_start) AS bucket, SUM(request_count)::int AS count
       FROM api_key_usage
       WHERE api_key_id = ANY($1) AND window_start >= now() - interval '30 days'
       GROUP BY bucket ORDER BY bucket`,
      [ids]
    ),
    pool.query(
      `SELECT endpoint_category, SUM(request_count)::int AS count
       FROM api_key_usage
       WHERE api_key_id = ANY($1) AND window_start >= now() - interval '24 hours'
       GROUP BY endpoint_category ORDER BY count DESC`,
      [ids]
    ),
    pool.query(
      `SELECT COALESCE(SUM(request_count), 0)::int AS count
       FROM api_key_usage
       WHERE api_key_id = ANY($1) AND window_start = date_trunc('minute', now())`,
      [ids]
    ),
  ]);

  const currentMinuteCount: number = currentMinute.rows[0]?.count ?? 0;
  const remaining =
    rateLimitPerMin == null ? null : Math.max(0, rateLimitPerMin - currentMinuteCount);
  const approachingLimit =
    rateLimitPerMin != null &&
    rateLimitPerMin > 0 &&
    currentMinuteCount >= rateLimitPerMin * APPROACHING_LIMIT_RATIO;

  return {
    apiKeyId,
    rateLimitPerMin,
    currentMinuteCount,
    remaining,
    approachingLimit,
    last24hByHour: byHour.rows.map((r) => ({
      windowStart: new Date(r.bucket).toISOString(),
      requestCount: r.count,
    })),
    last30dByDay: byDay.rows.map((r) => ({
      windowStart: new Date(r.bucket).toISOString(),
      requestCount: r.count,
    })),
    last24hByCategory: byCategory.rows.map((r) => ({
      category: r.endpoint_category,
      requestCount: r.count,
    })),
  };
}

/** Delete usage rows older than the retention window (issue #1043: retain ≥30 days). */
export async function pruneApiKeyUsage(retentionDays = 30): Promise<number> {
  const res = await pool.query(
    `DELETE FROM api_key_usage WHERE window_start < now() - ($1 || ' days')::interval`,
    [String(retentionDays)]
  );
  return res.rowCount ?? 0;
}
