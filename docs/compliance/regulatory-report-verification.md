# Regulatory Report Verification Script

`scripts/test-regulatory-report.ts` is a manual verification harness for the per-state regulatory compliance report API (`GET /api/v1/regulatory/state-report/:state`, implemented in `apps/api/src/routes/regulatory.ts`).

## Status: ad hoc, not run in CI

No workflow under `.github/workflows/` invokes this script. `git log -- scripts/test-regulatory-report.ts` shows it was added together with the regulatory report API (`e37fea9`) and has not been wired into CI since. Run it by hand when you change the regulatory routes, the report query, the CSV export, or the audit-log behaviour.

## Running it

```bash
docker compose up -d postgres && npm run migrate   # Postgres up and migrated
npm run dev:api                                      # API on http://localhost:3002
npm run test:regulatory-report                       # in another terminal
```

`DATABASE_URL` must be set (via `.env`), because the script seeds a state license and inspects the audit log directly in Postgres. The script creates a throwaway `surety_admin` user and removes it, its license and its audit-log rows at the end. Only run it against a local or dev database.

## What it checks

1. JSON report for a licensed state returns `200` with the expected shape (`stats`, `importerSegmentation`) and `X-Cache: MISS`.
2. A second identical request returns `X-Cache: HIT`.
3. `?format=csv` returns `text/csv` with a header row.
4. An unlicensed state returns `403`.
5. A `regulatory_report_audit_logs` row is written.

The process exits non-zero if any assertion fails.
