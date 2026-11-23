/**
 * scripts/ingest-dast-findings.ts
 *
 * Ingests an OWASP ZAP JSON report into the `security_findings` table.
 *
 * Usage:
 *   npx tsx scripts/ingest-dast-findings.ts
 *   npx tsx scripts/ingest-dast-findings.ts --file path/to/zap-report.json
 *   npx tsx scripts/ingest-dast-findings.ts path/to/zap-report.json   # positional form
 *
 * Flags:
 *   --file <path>  Path to the ZAP JSON report, relative to the current working
 *                  directory (defaults to report.json in cwd, matching CI).
 *
 * Environment:
 *   DATABASE_URL   Postgres connection string (defaults to the docker-compose
 *                  local database on localhost:5443).
 *
 * Requires the local Postgres from docker-compose to be running, e.g.
 * `docker compose up -d postgres`.
 */

import * as fs from "fs";
import * as path from "path";
import pg from "pg";

const { Pool } = pg;

const DEFAULT_REPORT_FILE = "report.json";

const databaseUrl = process.env.DATABASE_URL || "postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield";

/**
 * Resolves the report path from CLI arguments. Accepts `--file <path>`,
 * `--file=<path>`, or a bare positional `<path>`. Paths are resolved against
 * the current working directory; when nothing is passed, falls back to
 * report.json in cwd so existing CI invocations keep working.
 */
function resolveReportPath(argv: string[]): string {
  let fileArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      fileArg = argv[i + 1];
      if (!fileArg) {
        console.error("Missing value for --file <path>");
        process.exit(1);
      }
      i++;
    } else if (arg.startsWith("--file=")) {
      fileArg = arg.slice("--file=".length);
    } else if (!arg.startsWith("-") && fileArg === undefined) {
      fileArg = arg;
    }
  }

  if (!fileArg) {
    fileArg = DEFAULT_REPORT_FILE;
  }

  return path.resolve(process.cwd(), fileArg);
}

async function main() {
  const reportPath = resolveReportPath(process.argv.slice(2));
  if (!fs.existsSync(reportPath)) {
    console.error(`No DAST report found at ${reportPath}`);
    console.error(
      "Pass --file <path> to point at a different ZAP JSON report (default: report.json in cwd)."
    );
    process.exit(1);
  }

  const reportData = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const sites = Array.isArray(reportData.site) ? reportData.site : [reportData.site];
    let findingsCount = 0;

    for (const site of sites) {
      if (!site || !site.alerts) continue;

      for (const alert of site.alerts) {
        const severity = mapRiskCodeToSeverity(alert.riskcode);
        const instances = Array.isArray(alert.instances) ? alert.instances : [alert.instances];

        for (const instance of instances) {
          if (!instance) continue;
          
          const affectedEndpoint = `${instance.method || "GET"} ${instance.uri || ""}`;
          const remediationSla = calculateSla(severity);

          await pool.query(
            `INSERT INTO security_findings (severity, affected_endpoint, remediation_sla, status)
             VALUES ($1, $2, $3, 'open')`,
            [severity, affectedEndpoint, remediationSla]
          );
          findingsCount++;
        }
      }
    }

    console.log(`Successfully ingested ${findingsCount} DAST findings into database.`);
  } catch (error) {
    console.error("Failed to ingest DAST findings:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function mapRiskCodeToSeverity(riskcode: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  switch (riskcode) {
    case "3":
      return "HIGH";
    case "2":
      return "MEDIUM";
    case "1":
      return "LOW";
    case "0":
      return "INFO";
    default:
      return "MEDIUM";
  }
}

function calculateSla(severity: string): Date {
  const now = new Date();
  if (severity === "CRITICAL") {
    now.setHours(now.getHours() + 24); // 24h
  } else if (severity === "HIGH") {
    now.setDate(now.getDate() + 7); // 7d
  } else if (severity === "MEDIUM") {
    now.setDate(now.getDate() + 30); // 30d
  } else {
    now.setDate(now.getDate() + 90); // 90d
  }
  return now;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
