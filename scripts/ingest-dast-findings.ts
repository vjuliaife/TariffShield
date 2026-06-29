import * as fs from "fs";
import * as path from "path";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL || "postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield";

async function main() {
  const reportPath = path.resolve(process.cwd(), "report.json");
  if (!fs.existsSync(reportPath)) {
    console.error("No report.json found at", reportPath);
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
