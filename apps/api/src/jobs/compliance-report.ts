import { pool } from "../db.js";
import { env } from "../config/env.js";

// Monthly compliance report generation job (#319).
// Scheduled to run on the first business day of each month.
// Re-running for the same month overwrites the draft and marks the previous version superseded.

interface ReportData {
  month: string; // YYYY-MM
  bondPortfolio: {
    totalActive: number;
    newIssued: number;
    expiredOrCancelled: number;
    aggregateFaceValue: string;
  };
  kycActivity: {
    reviewsCompleted: number;
    approvals: number;
    rejections: number;
    pendingQueue: number;
  };
  amlScreening: {
    screened: number;
    flagsRaised: number;
    flagsResolved: number;
    sarEligibleEvents: number;
  };
  regulatoryActions: {
    bondsBelowCbpMinimum: number;
    bondsAwaitingSignature: number;
  };
}

async function buildReportData(monthStart: Date, monthEnd: Date): Promise<ReportData> {
  const month = monthStart.toISOString().slice(0, 7);

  const [
    activeBonds,
    newBonds,
    expiredBonds,
    faceValue,
    kycCompleted,
    kycApproved,
    kycRejected,
    kycPending,
    amlScreened,
    flagsRaised,
    flagsResolved,
    bondsBelowMin,
    bondsUnsigned,
  ] = await Promise.all([
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM bond_records
       WHERE created_at <= $2 AND (expiry_date IS NULL OR expiry_date > $1)`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM bond_records WHERE created_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM bond_records
       WHERE expiry_date IS NOT NULL AND expiry_date BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(bond_amount), 0) AS total FROM bond_records
       WHERE created_at <= $2 AND (expiry_date IS NULL OR expiry_date > $1)`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM kyc_documents WHERE reviewed_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM kyc_documents
       WHERE review_status = 'approved' AND reviewed_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM kyc_documents
       WHERE review_status = 'rejected' AND reviewed_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM importers WHERE kyc_status = 'pending'`,
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM aml_screenings WHERE screening_timestamp BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM compliance_flags WHERE created_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM compliance_flags
       WHERE resolution_status = 'resolved' AND resolved_at BETWEEN $1 AND $2`,
      [monthStart, monthEnd],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM bond_records WHERE bond_amount < cbp_minimum_required`,
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM bond_records WHERE surety_fein = 'TBD'`,
    ),
  ]);

  return {
    month,
    bondPortfolio: {
      totalActive: parseInt(activeBonds.rows[0]?.cnt ?? "0", 10),
      newIssued: parseInt(newBonds.rows[0]?.cnt ?? "0", 10),
      expiredOrCancelled: parseInt(expiredBonds.rows[0]?.cnt ?? "0", 10),
      aggregateFaceValue: faceValue.rows[0]?.total ?? "0",
    },
    kycActivity: {
      reviewsCompleted: parseInt(kycCompleted.rows[0]?.cnt ?? "0", 10),
      approvals: parseInt(kycApproved.rows[0]?.cnt ?? "0", 10),
      rejections: parseInt(kycRejected.rows[0]?.cnt ?? "0", 10),
      pendingQueue: parseInt(kycPending.rows[0]?.cnt ?? "0", 10),
    },
    amlScreening: {
      screened: parseInt(amlScreened.rows[0]?.cnt ?? "0", 10),
      flagsRaised: parseInt(flagsRaised.rows[0]?.cnt ?? "0", 10),
      flagsResolved: parseInt(flagsResolved.rows[0]?.cnt ?? "0", 10),
      sarEligibleEvents: 0, // populated by AML provider integration
    },
    regulatoryActions: {
      bondsBelowCbpMinimum: parseInt(bondsBelowMin.rows[0]?.cnt ?? "0", 10),
      bondsAwaitingSignature: parseInt(bondsUnsigned.rows[0]?.cnt ?? "0", 10),
    },
  };
}

// Stub: in production, render HTML via Puppeteer/PDFKit and upload to S3_REPORTS_BUCKET.
async function generateAndUploadPdf(
  reportData: ReportData,
  suretyId: string,
): Promise<string | null> {
  if (!env.S3_REPORTS_BUCKET) return null;
  const key = `reports/${suretyId}/${reportData.month}.pdf`;
  // Production: await puppeteer render + S3 PutObjectCommand with SSE-KMS
  return key;
}

// Stub: in production, use SendGrid/SES to email surety_admin users.
async function notifySuretyAdmins(suretyId: string, reportMonth: string): Promise<void> {
  if (!env.SENDGRID_API_KEY) {
    console.log(`[compliance-report] would email surety ${suretyId} re: ${reportMonth} report`);
    return;
  }
  // Production: fetch surety_admin emails, send via SendGrid
}

export async function generateMonthlyComplianceReport(
  targetMonth?: Date,
): Promise<void> {
  const now = targetMonth ?? new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const reportMonthDate = monthStart.toISOString().slice(0, 10);

  const suretyAdmins = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'surety_admin'`,
  );

  for (const admin of suretyAdmins.rows) {
    const suretyId = admin.id;

    try {
      const reportData = await buildReportData(monthStart, monthEnd);
      const pdfKey = await generateAndUploadPdf(reportData, suretyId);

      // Idempotency: mark previous version superseded, then upsert new one.
      await pool.query(
        `UPDATE compliance_reports SET superseded_at = now()
         WHERE surety_id = $1 AND report_month = $2 AND superseded_at IS NULL`,
        [suretyId, reportMonthDate],
      );

      await pool.query(
        `INSERT INTO compliance_reports (surety_id, report_month, report_data, pdf_s3_key)
         VALUES ($1, $2, $3, $4)`,
        [suretyId, reportMonthDate, JSON.stringify(reportData), pdfKey],
      );

      await notifySuretyAdmins(suretyId, reportMonthDate);
      console.log(`[compliance-report] generated ${reportMonthDate} report for surety ${suretyId}`);
    } catch (err) {
      console.error(`[compliance-report] failed for surety ${suretyId}:`, err);
    }
  }
}

// Cron scheduler: first business day of each month at 06:00 UTC.
function isFirstBusinessDayOfMonth(d: Date): boolean {
  if (d.getUTCDate() > 3) return false;
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  // First business day: no Mon–Fri day earlier in the month
  const firstOfMonth = new Date(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const firstDow = firstOfMonth.getUTCDay();
  const firstBizDay = firstDow === 0 ? 2 : firstDow === 6 ? 3 : 1;
  return d.getUTCDate() === firstBizDay;
}

export function startComplianceReportScheduler(): void {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

  async function tick() {
    const now = new Date();
    if (now.getUTCHours() === 6 && isFirstBusinessDayOfMonth(now)) {
      console.log("[compliance-report] triggering monthly report generation");
      await generateMonthlyComplianceReport(now).catch((err) =>
        console.error("[compliance-report] scheduler error:", err),
      );
    }
  }

  setInterval(() => {
    tick().catch((err) => console.error("[compliance-report] tick error:", err));
  }, CHECK_INTERVAL_MS);

  console.log("[compliance-report] scheduler started");
}
