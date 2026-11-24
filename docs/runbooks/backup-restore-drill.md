# Backup & Restore Drill Runbook

`scripts/backup-restore-drill.sh` performs the quarterly disaster recovery drill: it finds
the latest encrypted RDS snapshot, restores it to a temporary instance, validates schema
and data, writes a drill report, and deletes the temporary instance. This runbook covers
how to run the real drill and how to exercise its logic locally in dry-run mode.

**See also:** [`docs/security/BACKUP_ENCRYPTION_POLICY.md`](../security/BACKUP_ENCRYPTION_POLICY.md)
for the backup/encryption policy and retention rules.

---

## Local dry-run (no AWS credentials required)

Dry-run mode mocks the `aws` and `psql` calls with canned output, skips instance
creation/wait/deletion, S3 uploads, and DynamoDB writes, but still writes the drill
report so report-shape changes can be validated locally. Use it whenever you edit the
script's parsing, validation, or report JSON.

```bash
# Either form works:
bash scripts/backup-restore-drill.sh --dry-run
LOCAL_DRY_RUN=1 bash scripts/backup-restore-drill.sh

# Write the report somewhere specific and inspect it:
DRILL_REPORT_FILE=/tmp/dr-drill.json bash scripts/backup-restore-drill.sh --dry-run
cat /tmp/dr-drill.json | jq .
```

What happens in dry-run mode:

- `aws rds describe-db-snapshots` / `describe-db-instances` return canned values
  (`rds:tariffshield-prod-2026-01-01-00-00`, a fake endpoint, port `5432`).
- Schema/data validation queries return canned counts; the expected-table check still
  runs against the canned table list.
- Snapshot restore, `aws rds wait`, instance deletion, `aws s3 cp` upload, and the
  DynamoDB `put-item` are skipped with `[dry-run]` log lines. No AWS resource is created
  or deleted.
- The report is written to `DRILL_REPORT_FILE` (default: `dr-drill-<timestamp>.json`) with
  `"mode": "dry-run"` and `"status": "PASSED"`.

The dry-run path is covered by `scripts/__tests__/backup-restore-drill.test.ts`, which
also pins the report shape:

```bash
npx tsx --test scripts/__tests__/backup-restore-drill.test.ts
# or, repo-wide:
npm run test:scripts
```

---

## Real drill (quarterly)

Prerequisites:

| Requirement                           | Notes                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| AWS credentials                       | Must allow `rds:DescribeDBSnapshots`, `rds:RestoreDBInstanceFromDBSnapshot`, `rds:DeleteDBInstance`, `s3:PutObject`, `dynamodb:PutItem` |
| `AWS_REGION`                          | Defaults to `us-east-1`                                                                                                                 |
| `DB_USER` / `DB_NAME` / `DB_PASSWORD` | Credentials for the restored instance's validation queries                                                                              |
| `TEMP_DB_SUBNET_GROUP`                | Subnet group for the temporary instance (default `default-postgres`)                                                                    |
| `DR_EXPORT_S3_KEY`                    | Optional key of an encrypted export to decrypt/verify                                                                                   |

```bash
bash scripts/backup-restore-drill.sh
```

The script:

1. Locates the latest **encrypted** snapshot of `tariffshield-prod`.
2. Restores it to a temporary `tariffshield-dr-test-<epoch>` instance and waits for it.
3. Connects and validates schema completeness (expected tables) and data integrity
   (user/importer/contract-event counts, EIN format).
4. Optionally decrypts `DR_EXPORT_S3_KEY` from S3 via the Secrets Manager key.
5. Writes the drill report to `DRILL_REPORT_FILE`, uploads it to
   `s3://tariffshield-compliance/dr-drills/`, and records the run in the `backup-drills`
   DynamoDB table.
6. Deletes the temporary instance (`--skip-final-snapshot`).

Exit code `0` means the drill passed; any failure exits non-zero and leaves the report
(or logs describing the failure) for investigation.

## Troubleshooting

| Symptom                                | Likely cause / action                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `[ERROR] No encrypted snapshots found` | No encrypted snapshot exists for `tariffshield-prod`; trigger one per the backup policy first                            |
| Connection retry loop exhausts         | Temporary instance still booting or security group blocks access; check the RDS console and re-run                       |
| `[ERROR] Missing tables: ...`          | Restored snapshot predates a migration; restore a newer snapshot                                                         |
| `[ERROR] EIN format validation failed` | Data-corruption signal — escalate per the incident response playbook, do not delete the temporary instance until triaged |
