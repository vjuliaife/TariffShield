// #324 — Insurance license verification workflow for surety_admin accounts.
//
// Flow:
//   1. surety_admin signs up → pending record created automatically (see auth.ts).
//   2. surety_admin submits their NAIC number and company details via POST /surety-license/submit.
//   3. Platform admin reviews and approves or rejects via PUT /surety-license/:id/review.
//   4. Operational routes check requireLicenseVerified() middleware before proceeding.
//
// In production, step 3 can be automated by calling the NAIC Company Search API
// (https://www.naic.org/cis) or a state DOI licensing API to validate the
// NAIC number, confirm admitted-carrier status, and check A.M. Best rating.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, type AuthedRequest } from "../auth.js";

export const suretyLicenseRouter = Router();
suretyLicenseRouter.use(authMiddleware);

// ── Middleware ────────────────────────────────────────────────────────────────

function requireSuretyAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety_admin only" });
    return;
  }
  next();
}

// Exported so importers.ts can gate clawback / accrue-yield behind it.
export async function requireLicenseVerified(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    next();
    return;
  }
  const r = await pool.query(
    "SELECT status FROM surety_license_verifications WHERE user_id = $1",
    [user.id],
  );
  if (!r.rowCount || r.rows[0]?.status !== "verified") {
    res.status(403).json({
      error: "surety license not verified",
      message:
        "Submit your NAIC number and company details at POST /surety-license/submit, " +
        "then contact the platform admin for review.",
      currentStatus: r.rows[0]?.status ?? "no_record",
    });
    return;
  }
  next();
}

// ── POST /surety-license/submit ───────────────────────────────────────────────

const SubmitSchema = z.object({
  naicNumber: z.string().min(1).max(20),
  companyName: z.string().min(1).max(255),
  stateOfDomicile: z.string().length(2).toUpperCase(),
  amBestRating: z.string().max(10).optional(),
  licenseStatusDetail: z.string().max(1000).optional(),
});

suretyLicenseRouter.post("/submit", requireSuretyAdmin, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const parse = SubmitSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { naicNumber, companyName, stateOfDomicile, amBestRating, licenseStatusDetail } = parse.data;

  const r = await pool.query(
    `UPDATE surety_license_verifications
       SET naic_number         = $1,
           company_name        = $2,
           state_of_domicile   = $3,
           am_best_rating      = $4,
           license_status_detail = $5,
           status              = 'submitted',
           submitted_at        = now()
     WHERE user_id = $6
     RETURNING id, status`,
    [naicNumber, companyName, stateOfDomicile, amBestRating ?? null, licenseStatusDetail ?? null, user.id],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "no license verification record found for this account" });
    return;
  }

  res.json({
    message: "License details submitted for review. A platform admin will verify your NAIC credentials.",
    id: r.rows[0]!.id,
    status: r.rows[0]!.status,
  });
});

// ── GET /surety-license/status ────────────────────────────────────────────────

suretyLicenseRouter.get("/status", requireSuretyAdmin, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const r = await pool.query(
    `SELECT id, naic_number, company_name, state_of_domicile, am_best_rating,
            status, submitted_at, reviewed_at, rejection_reason, created_at
       FROM surety_license_verifications
      WHERE user_id = $1`,
    [user.id],
  );
  if (!r.rowCount) {
    res.status(404).json({ error: "no license verification record found" });
    return;
  }
  res.json({ verification: r.rows[0] });
});

// ── PUT /surety-license/:id/review ───────────────────────────────────────────
// Platform admin approves or rejects a submitted license.
// TODO: add a dedicated platform_admin role; for now any authenticated user may call this
// endpoint (access is controlled at the network/infra layer in production deployments).

const ReviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  rejectionReason: z.string().max(1000).optional(),
});

suretyLicenseRouter.put("/:id/review", async (req: Request, res: Response) => {
  const reviewer = (req as AuthedRequest).user;
  const parse = ReviewSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { action, rejectionReason } = parse.data;
  const newStatus = action === "approve" ? "verified" : "rejected";

  const r = await pool.query(
    `UPDATE surety_license_verifications
        SET status           = $1,
            reviewed_at      = now(),
            reviewer_id      = $2,
            rejection_reason = $3
      WHERE id = $4
      RETURNING id, status, user_id`,
    [newStatus, reviewer.id, rejectionReason ?? null, req.params.id],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "verification record not found" });
    return;
  }

  res.json({ id: r.rows[0]!.id, status: r.rows[0]!.status });
});

// ── GET /surety-license (admin: list all pending/submitted) ───────────────────

suretyLicenseRouter.get("/", async (req: Request, res: Response) => {
  const statusFilter = req.query.status as string | undefined;
  const validStatuses = ["pending", "submitted", "verified", "rejected"];

  const r = statusFilter && validStatuses.includes(statusFilter)
    ? await pool.query(
        `SELECT slv.id, slv.naic_number, slv.company_name, slv.state_of_domicile,
                slv.am_best_rating, slv.status, slv.submitted_at, slv.reviewed_at,
                slv.rejection_reason, u.email
           FROM surety_license_verifications slv
           JOIN users u ON u.id = slv.user_id
          WHERE slv.status = $1
          ORDER BY slv.created_at DESC`,
        [statusFilter],
      )
    : await pool.query(
        `SELECT slv.id, slv.naic_number, slv.company_name, slv.state_of_domicile,
                slv.am_best_rating, slv.status, slv.submitted_at, slv.reviewed_at,
                slv.rejection_reason, u.email
           FROM surety_license_verifications slv
           JOIN users u ON u.id = slv.user_id
          ORDER BY slv.created_at DESC`,
      );

  res.json({ verifications: r.rows });
});
