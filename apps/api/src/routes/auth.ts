import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { hashPassword, verifyPassword, signToken, authMiddleware, type AuthedRequest } from "../auth.js";

export const authRouter = Router();

const SignupSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  role: z.enum(["importer", "surety_admin"]).default("importer"),
});

authRouter.post("/signup", async (req: Request, res: Response) => {
  const parse = SignupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { email, password, role } = parse.data;
  const hash = await hashPassword(password);
  try {
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
      [email, hash, role],
    );
    const u = result.rows[0]!;
    res.json({ token: signToken({ id: u.id, email: u.email, role: u.role }), user: u });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      res.status(409).json({ error: "email already registered" });
      return;
    }
    throw err;
  }
});

const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string(),
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input" });
    return;
  }
  const r = await pool.query("SELECT id, email, password_hash, role FROM users WHERE email = $1", [
    parse.data.email,
  ]);
  if (r.rowCount === 0) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const u = r.rows[0]!;
  if (!(await verifyPassword(parse.data.password, u.password_hash))) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({
    token: signToken({ id: u.id, email: u.email, role: u.role }),
    user: { id: u.id, email: u.email, role: u.role },
  });
});

authRouter.get("/me", authMiddleware, (req: Request, res: Response) => {
  res.json({ user: (req as AuthedRequest).user });
});
