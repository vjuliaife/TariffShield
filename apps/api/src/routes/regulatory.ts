import { Router, type Request, type Response } from "express";
import { z } from "zod";
import pino from "pino";
import { pool } from "../db.js";
import { authMiddleware, requireRole, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

const logger = pino({ name: "regulatory-report" });

export const regulatoryRouter = Router();

// Apply authorization and compliance gates
regulatoryRouter.use(authMiddleware);
regulatoryRouter.use(privacyReacceptanceGate);
regulatoryRouter.use(tosReacceptanceGate);
regulatoryRouter.use(requireRole("surety_admin"));

// In-memory cache for regulatory reports with 24-hour TTL (86400000 ms)
interface CacheEntry {
  data: any;
  expiresAt: number;
}
const reportCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCached(key: string): any | null {
  const entry = reportCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    reportCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any): void {
  reportCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Zod Schema to parse date parameters and formats
const ReportQuerySchema = z.object({
  start_date: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  end_date: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

// GET /api/v1/regulatory/state-report/:state_code
regulatoryRouter.get("/state-report/:state_code", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const stateCode = String(req.params["state_code"] ?? "").toUpperCase();

  // 1. Enforce active license restriction for the specified state
  const licenses = await pool.query(
    "SELECT license_number FROM surety_state_licenses WHERE surety_id = $1 AND state_code = $2",
    [user.id, stateCode],
  );

  if (!licenses.rowCount || licenses.rowCount === 0) {
    res.status(403).json({
      error: "Access Denied",
      message: `A active surety license record is required for state '${stateCode}' to generate this report.`,
    });
    return;
  }

  // 2. Parse query parameters
  const parseQuery = ReportQuerySchema.safeParse(req.query);
  if (!parseQuery.success) {
    res.status(400).json({ error: "invalid query parameters", details: parseQuery.error.issues });
    return;
  }

  const { start_date, end_date, format } = parseQuery.data;

  // Resolve reporting period dates (defaulting to last 30 days if unspecified)
  const startDate = start_date ? new Date(start_date) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = end_date ? new Date(end_date) : new Date();

  if (startDate > endDate) {
    res.status(400).json({ error: "start_date must be before or equal to end_date" });
    return;
  }

  // 3. Cache lookup
  const cacheKey = `${stateCode}:${user.id}:${startDate.getTime()}:${endDate.getTime()}:${format}`;
  const cachedData = getCached(cacheKey);

  if (cachedData !== null) {
    res.setHeader("X-Cache", "HIT");
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="regulatory_report_${stateCode}.csv"`);
      res.send(cachedData);
    } else {
      res.json(cachedData);
    }
    return;
  }

  // 4. Data aggregation queries covering the reporting period:
  // a) Total bonds written and aggregate face value in target state
  const bondsQuery = await pool.query<{ total_bonds: string; aggregate_face_value: string }>(
    `SELECT COUNT(*)::text as total_bonds, COALESCE(SUM(bond_amount), 0)::text as aggregate_face_value
     FROM bond_records
     WHERE state_code = $1
       AND effective_date >= $2
       AND effective_date <= $3`,
    [stateCode, startDate, endDate],
  );
  
  const totalBonds = parseInt(bondsQuery.rows[0]?.total_bonds ?? "0", 10);
  const aggregateFaceValue = bondsQuery.rows[0]?.aggregate_face_value ?? "0";

  // b) Claims filed (events with kind 'clawback') of qualifying state bonds within the period
  const claimsQuery = await pool.query<{ claims_count: string }>(
    `SELECT COUNT(*)::text as claims_count
     FROM contract_events ce
     JOIN importers i ON ce.importer_id = i.id
     JOIN bond_records br ON br.importer_id = i.id
     WHERE ce.kind = 'clawback'
       AND br.state_code = $1
       AND ce.created_at >= $2
       AND ce.created_at <= $3`,
    [stateCode, startDate, endDate],
  );
  const claimsFiled = parseInt(claimsQuery.rows[0]?.claims_count ?? "0", 10);

  // c) On-chain collateral held for qualifying active importers in targeted state
  const collateralQuery = await pool.query<{ collateral_held: string }>(
    `SELECT COALESCE(SUM(i.collateral_balance), 0)::text as collateral_held
     FROM importers i
     JOIN bond_records br ON br.importer_id = i.id
     WHERE br.state_code = $1
       AND br.effective_date >= $2
       AND br.effective_date <= $3`,
    [stateCode, startDate, endDate],
  );
  const collateralHeld = collateralQuery.rows[0]?.collateral_held ?? "0";

  // d) Importer counts segmented by business registration state
  const segmentQuery = await pool.query<{ business_state: string; importer_count: string }>(
    `SELECT COALESCE(i.business_state, 'UNKNOWN') as business_state, COUNT(DISTINCT i.id)::text as importer_count
     FROM importers i
     JOIN bond_records br ON br.importer_id = i.id
     WHERE br.state_code = $1
       AND br.effective_date >= $2
       AND br.effective_date <= $3
     GROUP BY COALESCE(i.business_state, 'UNKNOWN')`,
    [stateCode, startDate, endDate],
  );

  const importerSegmentation = segmentQuery.rows.map((row: { business_state: string; importer_count: string }) => ({
    businessState: row.business_state,
    count: parseInt(row.importer_count, 10),
  }));

  const totalImporterCount = importerSegmentation.reduce((acc: number, curr: { count: number }) => acc + curr.count, 0);

  // 5. Generate Response Data
  let responseData: any;

  if (format === "csv") {
    let csvData = "State Code,Total Bonds Written,Aggregate Face Value,Claims Filed,Collateral Held On-Chain,Importer Business Registration State,Importer Count\r\n";
    if (importerSegmentation.length === 0) {
      csvData += `${stateCode},${totalBonds},${aggregateFaceValue},${claimsFiled},${collateralHeld},,0\r\n`;
    } else {
      for (const segment of importerSegmentation) {
        csvData += `${stateCode},${totalBonds},${aggregateFaceValue},${claimsFiled},${collateralHeld},${segment.businessState},${segment.count}\r\n`;
      }
    }
    responseData = csvData;
  } else {
    responseData = {
      stateCode,
      reportingPeriod: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      stats: {
        totalBondsWritten: totalBonds,
        aggregateFaceValue,
        claimsFiled,
        collateralHeldOnChain: collateralHeld,
        totalImporterCount,
      },
      importerSegmentation,
    };
  }

  // 6. Audit Logging: DB entry and structured Logger log (SOC 2 audit trail compliance)
  await pool.query(
    `INSERT INTO regulatory_report_audit_logs (surety_id, state_code, start_date, end_date, output_format)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, stateCode, startDate, endDate, format],
  );

  logger.info({
    event: "regulatory_report_generation",
    suretyId: user.id,
    suretyEmail: user.email,
    stateCode,
    period: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    outputFormat: format,
  }, "Compliance report generated for regulator");

  // 7. Write to cache and send response
  setCache(cacheKey, responseData);
  res.setHeader("X-Cache", "MISS");

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="regulatory_report_${stateCode}.csv"`);
    res.send(responseData);
  } else {
    res.json(responseData);
  }
});
