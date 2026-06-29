# Security Response

TariffShield dependency audits run on pull requests, on a daily schedule, and on manual dispatch. The audit workflow checks npm dependencies for critical vulnerabilities and Cargo dependencies for high or critical advisories.

## Triage

When the scheduled audit opens a security issue, assign an owner and review the attached `npm-audit-report.json` and `cargo-audit-report.json` artifacts. Confirm the affected package, advisory ID or CVE, reachable code path, available patched version, and whether the vulnerable package is used in production.

## Response SLA

Critical dependency vulnerabilities must have an approved mitigation plan within 24 hours. The preferred mitigation is upgrading or pinning to a fixed version. If no fix is available, document the compensating control, exposure, and follow-up date in the tracking issue.

High Cargo advisories should be handled with the same process unless maintainers document that the affected crate is not built or reachable in deployed artifacts.

## Patch Process

1. Open a focused dependency update PR.
2. Include the advisory ID or CVE in the PR body.
3. Attach local audit output or link to the failing scheduled workflow.
4. Run the relevant application tests and audit command again.
5. Close the scheduled audit issue only after the workflow passes or the mitigation is documented.
