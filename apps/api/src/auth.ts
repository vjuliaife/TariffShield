import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";
import { pool, validateSession, touchSession } from "./db.js";

// ── SOC 2 CC6.3 — Formal RBAC access matrix ──────────────────────────────────
// Documents the least-privilege role assignments enforced per route group.
// Enforcement is via authMiddleware (authentication) and per-route requireRole /
// requireLicenseVerified checks (authorization). This constant is the authoritative
// source of truth for auditors; keep it in sync with route definitions.
export const ROLE_PERMISSIONS = {
  importer: [
    "POST /importers",
    "GET /importers/own",
    "GET /importers/:id (own)",
    "GET /importers/:id/collateral-status (own)",
    "POST /importers/:id/upload-tariff-csv (own)",
    "POST /importers/:id/deposit (own, KYC-gated)",
    "POST /importers/:id/auto-top-up (own)",
    "POST /importers/:id/withdraw (own)",
    "GET /importers/:id/kyc (own)",
    "POST /importers/:id/kyc (own)",
    "POST /account/erasure-request",
    "GET /account/erasure-request/:id",
    "GET /privacy-policy-history",
    "POST /account/accept-privacy-policy",
  ],
  surety_admin: [
    "GET /importers/* (all)",
    "GET /importers/:id (all)",
    "POST /importers/:id/accrue-yield (license-verified)",
    "POST /importers/:id/clawback (license-verified)",
    "GET /importers/:id/kyc/:docId/review",
    "GET /admin/oracle-alerts",
    "PATCH /admin/oracle-alerts/:id/acknowledge",
    "GET /admin/roles",
    "POST /admin/privacy-policy/publish",
    "GET /admin/access-review",
    "GET /compliance/dashboard",
    "GET /compliance/flags",
    "POST /compliance/flags/:id/resolve",
    "GET /compliance/reports",
    "GET /compliance/reports/:id/download",
    "POST /bonds/:id/send-for-signature",
    "GET /bonds/:id/signature-status",
    "POST /bonds/:id/send-reminder",
    "POST /surety-license/submit",
    "GET /surety-license/status",
  ],
  admin: ["ALL — reserved for platform operator via direct DB or Stellar keypair operations"],
} as const;

// Concurrent session limits per role (SOC 2 CC6.1)
export const MAX_SESSIONS: Record<"importer" | "surety_admin", number> = {
  importer: 5,
  surety_admin: 3,
};

export interface AuthPayload {
  id: string;
  email: string;
  role: "importer" | "surety_admin";
  sessionId?: string;
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
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
  } catch {
    res.status(401).json({ error: "invalid token" });
    return;
  }
  (req as AuthedRequest).user = payload;

  // SOC 2 CC6.1: every valid token must carry a sessionId.
  // All token-issuing paths (login, signup, SAML callback) create a session row
  // and embed the sessionId in the JWT, so this rejects only forged or pre-rollout tokens.
  if (!payload.sessionId) {
    res.status(401).json({ error: "re-authentication required" });
    return;
  }

  validateSession(payload.sessionId).then((valid) => {
    if (!valid) {
      res.status(401).json({ error: "session expired or not found" });
      return;
    }
    touchSession(payload.sessionId!);
    next();
  }).catch(() => {
    // Fail closed: if session validation is unavailable the request is blocked.
    // This ensures the 15-minute inactivity control is never bypassed by a DB outage.
    res.status(503).json({ error: "session validation unavailable" });
  });
}

export function requireRole(role: AuthPayload["role"]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (user.role !== role) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}

// #322 — gate requests when a new privacy policy requires re-acceptance.
// Exempt: the accept-privacy-policy endpoint itself and the current-version endpoint.
const PRIVACY_EXEMPT_PATHS = [
  "/account/accept-privacy-policy",
  "/account/accept-tos",
  "/account/tos-history",
  "/privacy/current-version",
  "/auth/",
];

export function privacyReacceptanceGate(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user) { next(); return; }

  const isExempt = PRIVACY_EXEMPT_PATHS.some(p => req.path.includes(p));
  if (isExempt) { next(); return; }

  // Async check — look up live DB value (not stale JWT claim). Fail closed:
  // if the DB is unreachable we cannot confirm acceptance status, so the
  // request is blocked. authMiddleware's session validation runs first and
  // will 503 on a full DB outage before this gate is ever reached.
  pool.query<{ privacy_reacceptance_required: boolean }>(
    "SELECT privacy_reacceptance_required FROM users WHERE id = $1",
    [user.id],
  ).then(result => {
    if (result.rows[0]?.privacy_reacceptance_required) {
      res.status(403).json({
        error: "privacy policy update requires re-acceptance",
        reason: "privacy_policy_update",
        action: "POST /account/accept-privacy-policy",
      });
      return;
    }
    next();
  }).catch(() => {
    res.status(503).json({ error: "service temporarily unavailable" });
  });
}

export function tosReacceptanceGate(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user) { next(); return; }

  const isExempt = PRIVACY_EXEMPT_PATHS.some(p => req.path.includes(p));
  if (isExempt) { next(); return; }

  pool.query<{ tos_reacceptance_required: boolean }>(
    "SELECT tos_reacceptance_required FROM users WHERE id = $1",
    [user.id],
  ).then(result => {
    if (result.rows[0]?.tos_reacceptance_required) {
      res.status(403).json({
        error: "terms of service update requires re-acceptance",
        reason: "tos_acceptance_required",
        action: "POST /api/v1/account/accept-tos",
      });
      return;
    }
    next();
  }).catch(() => next());
}
