import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";
import { pool } from "./db.js";

export interface AuthPayload {
  id: string;
  email: string;
  role: "importer" | "surety_admin";
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
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
    (req as AuthedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
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

  // Async check — look up live DB value (not stale JWT claim)
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
  }).catch(() => next()); // fail-open: don't block if DB unreachable
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
