import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";

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
