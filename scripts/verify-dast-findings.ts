import * as fs from "fs";
import * as path from "path";

async function main() {
  const reportPath = path.resolve(process.cwd(), "report.json");
  if (!fs.existsSync(reportPath)) {
    console.error("No report.json found.");
    process.exit(1);
  }

  const reportData = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const sites = Array.isArray(reportData.site) ? reportData.site : [reportData.site];
  const highOrCriticalFindings: any[] = [];

  for (const site of sites) {
    if (!site || !site.alerts) continue;

    for (const alert of site.alerts) {
      const riskcode = parseInt(alert.riskcode || "0", 10);
      if (riskcode >= 3) {
        highOrCriticalFindings.push(alert);
      }
    }
  }

  if (highOrCriticalFindings.length > 0) {
    console.error("FAILING PIPELINE: High or Critical security findings detected by DAST:");
    for (const finding of highOrCriticalFindings) {
      console.error(`- [Risk ${finding.riskcode}] ${finding.alert}: ${finding.desc}`);
    }
    process.exit(1);
  } else {
    console.log("No High or Critical DAST findings detected. Pipeline check passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
