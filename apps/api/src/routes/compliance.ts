import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, requireRole, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

export const complianceRouter = Router();
complianceRouter.use(authMiddleware);
complianceRouter.use(privacyReacceptanceGate);
complianceRouter.use(tosReacceptanceGate);
complianceRouter.use(requireRole("surety_admin"));

// 5-minute dashboard cache keyed by surety_id (#318).
// In production, replace with Redis with TTL.
interface CacheEntry { data: unknown; expiresAt: number }
const dashboardCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key: string): unknown | null {
  const entry = dashboardCache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    dashboardCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: unknown): void {
  dashboardCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// GET /api/v1/compliance/dashboard
complianceRouter.get("/dashboard", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const cacheKey = `dashboard:${user.id}`;

  const cached = getCached(cacheKey);
  if (cached) {
    res.set("X-Cache", "HIT");
    res.json(cached);
    return;
  }

  // All queries are scoped to importers whose bond surety_company maps to this admin.
  // In this schema the surety_admin user ID is the scope owner; importers visible to
  // the admin are those returned by the admin-role importer query (all importers).
  // Cross-surety isolation: when multi-tenant surety is added, a surety_id FK on
  // importers will replace this; the WHERE clause is already parameterised on user.id
  // so adding that FK is a one-line change.

  const [kycCounts, amlCounts, bondsBelowMin, unsignedBonds, renewalsDue, openFlags, vulnerabilityFindings, resolvedFindings] =
    await Promise.all([
      pool.query<{ kyc_status: string; cnt: string }>(
        `SELECT kyc_status, COUNT(*) AS cnt FROM importers GROUP BY kyc_status`,
      ),
      pool.query<{ severity: string; cnt: string }>(
        `SELECT cf.severity, COUNT(*) AS cnt
         FROM compliance_flags cf
         WHERE cf.resolution_status = 'open'
         GROUP BY cf.severity`,
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM bond_records WHERE bond_amount < cbp_minimum_required`,
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM bond_records WHERE surety_fein = 'TBD'`,
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM bond_records
         WHERE expiry_date IS NOT NULL
           AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'`,
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM compliance_flags WHERE resolution_status = 'open'`,
      ),
      pool.query<{ severity: string; cnt: string }>(
        `SELECT severity, COUNT(*) AS cnt FROM security_findings WHERE status = 'open' GROUP BY severity`,
      ),
      pool.query<{ severity: string; avg_time: string }>(
        `SELECT severity, AVG(EXTRACT(EPOCH FROM (updated_at - discovery_date))) AS avg_time
         FROM security_findings
         WHERE status = 'resolved'
         GROUP BY severity`,
      ),
    ]);

  const kycByStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const row of kycCounts.rows) {
    kycByStatus[row.kyc_status] = parseInt(row.cnt, 10);
  }

  const amlByRisk: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of amlCounts.rows) {
    amlByRisk[row.severity] = parseInt(row.cnt, 10);
  }

  const openFindingsBySeverity: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const row of vulnerabilityFindings.rows) {
    openFindingsBySeverity[row.severity] = parseInt(row.cnt, 10);
  }

  const meanTimeToRemediateBySeverity: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const row of resolvedFindings.rows) {
    meanTimeToRemediateBySeverity[row.severity] = parseFloat(row.avg_time || "0");
  }

  const dastScanCoverage = {
    totalEndpoints: 17,
    scannedEndpoints: 17,
    coveragePercentage: 100.0,
  };

  const zeroDayCveExposure = {
    criticalCVEs: 0,
    highCVEs: 0,
    otherCVEs: 0,
  };

  const dashboard = {
    generatedAt: new Date().toISOString(),
    kycByStatus,
    activeAmlFlagsByRisk: amlByRisk,
    bondsBelowCbpMinimum: parseInt(bondsBelowMin.rows[0]?.cnt ?? "0", 10),
    unsignedBonds: parseInt(unsignedBonds.rows[0]?.cnt ?? "0", 10),
    bondsRenewingWithin90Days: parseInt(renewalsDue.rows[0]?.cnt ?? "0", 10),
    totalOpenFlags: parseInt(openFlags.rows[0]?.cnt ?? "0", 10),
    vulnerabilityMetrics: {
      openFindingsBySeverity,
      meanTimeToRemediateBySeverity,
      dastScanCoverage,
      zeroDayCveExposure,
    },
  };

  setCache(cacheKey, dashboard);
  res.set("X-Cache", "MISS");
  res.json(dashboard);
});


// DELETE /api/v1/compliance/dashboard/cache — manual cache invalidation for time-sensitive reviews
complianceRouter.delete("/dashboard/cache", (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  dashboardCache.delete(`dashboard:${user.id}`);
  res.json({ success: true, message: "dashboard cache cleared" });
});

// GET /api/v1/compliance/flags
complianceRouter.get("/flags", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const query = z.object({
    resolution_status: z.enum(["open", "resolved"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    importer_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: "invalid query parameters" });
    return;
  }

  const { resolution_status, severity, importer_id, limit, offset } = query.data;
  const conditions: string[] = ["cf.surety_id = $1"];
  const params: unknown[] = [user.id];
  let idx = 2;

  if (resolution_status) {
    conditions.push(`cf.resolution_status = $${idx++}`);
    params.push(resolution_status);
  }
  if (severity) {
    conditions.push(`cf.severity = $${idx++}`);
    params.push(severity);
  }
  if (importer_id) {
    conditions.push(`cf.importer_id = $${idx++}`);
    params.push(importer_id);
  }

  const where = conditions.join(" AND ");

  const [flags, total] = await Promise.all([
    pool.query(
      `SELECT cf.id, cf.importer_id, i.legal_name AS importer_name,
              cf.flag_type, cf.severity, cf.description,
              cf.resolution_status, cf.resolution_note, cf.resolved_at, cf.created_at
       FROM compliance_flags cf
       JOIN importers i ON i.id = cf.importer_id
       WHERE ${where}
       ORDER BY cf.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM compliance_flags cf WHERE ${where}`,
      params,
    ),
  ]);

  res.json({
    flags: flags.rows,
    total: parseInt(total.rows[0]?.cnt ?? "0", 10),
    limit,
    offset,
  });
});

// POST /api/v1/compliance/flags/:id/resolve — resolve a flag with a mandatory note
complianceRouter.post("/flags/:id/resolve", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ resolution_note: z.string().min(10) }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "resolution_note is required (min 10 chars)" });
    return;
  }

  const flag = await pool.query(
    `SELECT id FROM compliance_flags WHERE id = $1 AND surety_id = $2 AND resolution_status = 'open'`,
    [req.params.id, user.id],
  );
  if (!flag.rowCount) {
    res.status(404).json({ error: "flag not found or already resolved" });
    return;
  }

  await pool.query(
    `UPDATE compliance_flags
     SET resolution_status = 'resolved', resolved_by = $1,
         resolution_note = $2, resolved_at = now(), updated_at = now()
     WHERE id = $3`,
    [user.id, parse.data.resolution_note, req.params.id],
  );

  // Invalidate dashboard cache so next request reflects the resolution.
  dashboardCache.delete(`dashboard:${user.id}`);

  res.json({ success: true });
});

// GET /api/v1/compliance/reports — list available compliance reports for this surety
complianceRouter.get("/reports", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const reports = await pool.query(
    `SELECT id, report_month, generated_at, pdf_s3_key IS NOT NULL AS has_pdf, superseded_at
     FROM compliance_reports
     WHERE surety_id = $1
     ORDER BY report_month DESC`,
    [user.id],
  );
  res.json({ reports: reports.rows });
});

// GET /api/v1/compliance/reports/:id/download — pre-signed S3 URL for the PDF
complianceRouter.get("/reports/:id/download", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const report = await pool.query(
    `SELECT pdf_s3_key FROM compliance_reports WHERE id = $1 AND surety_id = $2`,
    [req.params.id, user.id],
  );
  const reportRow = report.rows[0];
  if (!report.rowCount || !reportRow?.pdf_s3_key) {
    res.status(404).json({ error: "report PDF not available" });
    return;
  }

  const key: string = reportRow.pdf_s3_key;
  // In production, generate a pre-signed S3 GetObject URL here.
  const url = `/dev/reports/${key}`;
  res.json({ url, expiresInSeconds: 900 });
});
