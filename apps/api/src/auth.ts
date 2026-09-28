import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from './config/env.js';
import { pool, validateSession, touchSession } from './db.js';
import { checkApiKeyRateLimit } from './services/api-key-rate-limiter.js';

// ── SOC 2 CC6.3 — Formal RBAC access matrix ──────────────────────────────────
// Documents the least-privilege role assignments enforced per route group.
// Enforcement is via authMiddleware (authentication) and per-route requireRole /
// requireLicenseVerified checks (authorization). This constant is the authoritative
// source of truth for auditors; keep it in sync with route definitions.
export const ROLE_PERMISSIONS = {
  importer: [
    'POST /importers',
    'GET /importers/own',
    'GET /importers/:id (own)',
    'GET /importers/:id/collateral-status (own)',
    'GET /importers/:id/bonds (own)',
    'POST /importers/:id/upload-tariff-csv (own)',
    'POST /importers/:id/deposit (own, KYC-gated)',
    'POST /importers/:id/auto-top-up (own)',
    'POST /importers/:id/withdraw (own)',
    'GET /importers/:id/kyc (own)',
    'POST /importers/:id/kyc (own)',
    'POST /account/erasure-request',
    'GET /account/erasure-request/:id',
    'GET /privacy-policy-history',
    'POST /account/accept-privacy-policy',
  ],
  surety_admin: [
    'GET /importers/* (all)',
    'GET /importers/:id (all)',
    'GET /importers/:id/bonds (all)',
    'POST /importers/:id/accrue-yield (license-verified)',
    'POST /importers/:id/clawback (license-verified)',
    'GET /importers/:id/kyc/:docId/review',
    'GET /admin/oracle-alerts',
    'PATCH /admin/oracle-alerts/:id/acknowledge',
    'GET /admin/roles',
    'GET /admin/audit-log',
    'POST /admin/privacy-policy/publish',
    'GET /admin/access-review',
    'GET /compliance/dashboard',
    'GET /compliance/flags',
    'POST /compliance/flags/:id/resolve',
    'GET /compliance/reports',
    'GET /compliance/reports/:id/download',
    'POST /bonds/:id/send-for-signature',
    'GET /bonds/:id/signature-status',
    'POST /bonds/:id/send-reminder',
    'POST /surety-license/submit',
    'GET /surety-license/status',
    'GET /api/v1/regulatory/state-report/:state_code',
    'GET /branding',
    'PUT /branding',
    'DELETE /branding',
  ],
  admin: ['ALL — reserved for platform operator via direct DB or Stellar keypair operations'],
  // #988 — importer-scoped only, and only for importers with an active
  // (non-revoked) broker_importer_grants row for this broker. No access to
  // any surety_admin-only route.
  broker: [
    'GET /importers/broker/mine',
    'GET /importers/:id (grant-scoped)',
    'GET /importers/:id/collateral-status (grant-scoped)',
    'GET /importers/:id/bonds (grant-scoped)',
  ],
} as const;

// Concurrent session limits per role (SOC 2 CC6.1)
export const MAX_SESSIONS: Record<'importer' | 'surety_admin' | 'broker', number> = {
  importer: 5,
  surety_admin: 3,
  broker: 5,
};

export interface AuthPayload {
  id: string;
  email: string;
  // #988 — 'broker' is a delegated-access role: a broker owns no importer
  // account itself but can be granted scoped read/action access to other
  // users' importer accounts via broker_importer_grants (see routes/broker.ts).
  // It deliberately never gets requireRole('surety_admin') anywhere, which is
  // what keeps it excluded from destructive admin-only actions.
  role: 'importer' | 'surety_admin' | 'broker';
  sessionId?: string;
  apiKeyId?: string;
  importerId?: string;
}

export interface AuthedRequest extends Request {
  user: AuthPayload;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKeyHeader = req.header('x-api-key');
  const authHeader = req.header('authorization');

  // Check for API key in X-Api-Key or Authorization: Bearer ts_live_... / ApiKey ... (#995)
  let rawApiKey: string | null = null;
  if (apiKeyHeader) {
    rawApiKey = apiKeyHeader.trim();
  } else if (authHeader?.startsWith('ApiKey ')) {
    rawApiKey = authHeader.slice(7).trim();
  } else if (authHeader?.startsWith('Bearer ts_live_')) {
    rawApiKey = authHeader.slice(7).trim();
  }

  if (rawApiKey) {
    const keyHash = createHash('sha256').update(rawApiKey).digest('hex');
    try {
      const keyRes = await pool.query<{
        id: string;
        user_id: string;
        importer_id: string | null;
        scopes: string[];
        rate_limit_per_min: number | null;
        revoked_at: Date | null;
        expires_at: Date | null;
        email: string;
        role: 'importer' | 'surety_admin';
      }>(
        `SELECT k.id, k.user_id, k.importer_id, k.scopes, k.rate_limit_per_min,
                k.revoked_at, k.expires_at, u.email, u.role
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = $1`,
        [keyHash]
      );

      if (!keyRes.rowCount) {
        res.status(401).json({ error: 'invalid api key' });
        return;
      }

      const keyRow = keyRes.rows[0]!;

      // Revoked keys immediately return 401 on subsequent requests (#995 AC 5)
      if (keyRow.revoked_at) {
        res.status(401).json({ error: 'api key is revoked' });
        return;
      }

      // Expired keys check
      if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
        res.status(401).json({ error: 'api key has expired' });
        return;
      }

      // Independent rate limiting per API key (#995 AC 3)
      const limit = keyRow.rate_limit_per_min || 60;
      const rateCheck = checkApiKeyRateLimit(keyRow.id, limit);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
      if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(rateCheck.resetMs / 1000)));
        res.status(429).json({ error: 'rate limit exceeded', message: 'API key rate limit exceeded' });
        return;
      }

      // Touch last_used_at asynchronously
      pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyRow.id]).catch(() => undefined);

      (req as AuthedRequest).user = {
        id: keyRow.user_id,
        email: keyRow.email,
        role: keyRow.role,
        apiKeyId: keyRow.id,
        importerId: keyRow.importer_id ?? undefined,
        sessionId: 'api-key-auth',
      };

      next();
      return;
    } catch {
      res.status(503).json({ error: 'api key validation unavailable' });
      return;
    }
  }

  // Session-based JWT authentication
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(authHeader.slice(7), env.JWT_SECRET) as AuthPayload;
  } catch {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  (req as AuthedRequest).user = payload;

  // SOC 2 CC6.1: every valid token must carry a sessionId.
  // All token-issuing paths (login, signup, SAML callback) create a session row
  // and embed the sessionId in the JWT, so this rejects only forged or pre-rollout tokens.
  if (!payload.sessionId) {
    res.status(401).json({ error: 're-authentication required' });
    return;
  }

  validateSession(payload.sessionId)
    .then((valid) => {
      if (!valid) {
        res.status(401).json({ error: 'session expired or not found' });
        return;
      }
      touchSession(payload.sessionId!);
      next();
    })
    .catch(() => {
      // Fail closed: if session validation is unavailable the request is blocked.
      // This ensures the 15-minute inactivity control is never bypassed by a DB outage.
      res.status(503).json({ error: 'session validation unavailable' });
    });
}

export function requireRole(role: AuthPayload['role']) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (user.role !== role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

// #322 — gate requests when a new privacy policy requires re-acceptance.
// Exempt: the accept-privacy-policy endpoint itself and the current-version endpoint.
const PRIVACY_EXEMPT_PATHS = [
  '/account/accept-privacy-policy',
  '/account/accept-tos',
  '/account/tos-history',
  '/privacy/current-version',
  '/auth/',
];

export function privacyReacceptanceGate(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user || user.apiKeyId) {
    next();
    return;
  }

  const isExempt = PRIVACY_EXEMPT_PATHS.some((p) => req.path.includes(p));
  if (isExempt) {
    next();
    return;
  }

  // Async check — look up live DB value (not stale JWT claim). Fail closed:
  // if the DB is unreachable we cannot confirm acceptance status, so the
  // request is blocked. authMiddleware's session validation runs first and
  // will 503 on a full DB outage before this gate is ever reached.
  pool
    .query<{ privacy_reacceptance_required: boolean }>(
      'SELECT privacy_reacceptance_required FROM users WHERE id = $1',
      [user.id]
    )
    .then((result) => {
      if (result.rows[0]?.privacy_reacceptance_required) {
        res.status(403).json({
          error: 'privacy policy update requires re-acceptance',
          reason: 'privacy_policy_update',
          action: 'POST /account/accept-privacy-policy',
        });
        return;
      }
      next();
    })
    .catch(() => {
      res.status(503).json({ error: 'service temporarily unavailable' });
    });
}

export function tosReacceptanceGate(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user || user.apiKeyId) {
    next();
    return;
  }

  const isExempt = PRIVACY_EXEMPT_PATHS.some((p) => req.path.includes(p));
  if (isExempt) {
    next();
    return;
  }

  pool
    .query<{ tos_reacceptance_required: boolean }>(
      'SELECT tos_reacceptance_required FROM users WHERE id = $1',
      [user.id]
    )
    .then((result) => {
      if (result.rows[0]?.tos_reacceptance_required) {
        res.status(403).json({
          error: 'terms of service update requires re-acceptance',
          reason: 'tos_acceptance_required',
          action: 'POST /api/v1/account/accept-tos',
        });
        return;
      }
      next();
    })
    .catch(() => next());
}
