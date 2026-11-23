#!/bin/bash

set -euo pipefail

# Quarterly disaster recovery drill script
# Restores from the latest encrypted backup, validates schema and data, then deletes the temporary instance.
#
# Usage:
#   bash scripts/backup-restore-drill.sh                  # real drill (requires AWS credentials + RDS access)
#   bash scripts/backup-restore-drill.sh --dry-run        # offline dry run: mocked aws/psql, canned data
#   LOCAL_DRY_RUN=1 bash scripts/backup-restore-drill.sh  # same as --dry-run
#   bash scripts/backup-restore-drill.sh --help
#
# Dry-run mode mocks the `aws` and `psql` CLIs with canned output, skips instance
# creation/wait/deletion, S3 uploads, and DynamoDB writes, but still writes
# DRILL_REPORT_FILE so report-shape changes can be validated locally.
# See docs/runbooks/backup-restore-drill.md.

usage() {
  cat <<'EOF'
Usage: backup-restore-drill.sh [--dry-run] [--help]

  --dry-run  Run the drill with mocked aws/psql calls and canned data. No RDS
             instance is created, waited on, or deleted; no S3 or DynamoDB
             writes happen. The drill report is still written to
             DRILL_REPORT_FILE (default: dr-drill-<timestamp>.json).
             Also enabled with LOCAL_DRY_RUN=1.
  --help     Show this help.

Environment:
  AWS_REGION             AWS region (default: us-east-1)
  TEMP_DB_SUBNET_GROUP   Subnet group for the temporary instance (default: default-postgres)
  DRILL_REPORT_FILE      Path for the JSON report (default: dr-drill-<timestamp>.json)
  DB_USER / DB_NAME      Database credentials used by the validation queries
  DR_EXPORT_S3_KEY       Optional encrypted export key; skipped in dry-run
EOF
}

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "[ERROR] Unknown argument: $arg"
      usage
      exit 1
      ;;
  esac
done

if [ "${LOCAL_DRY_RUN:-0}" = "1" ] || [ "${LOCAL_DRY_RUN:-}" = "true" ]; then
  DRY_RUN=true
fi

REGION="${AWS_REGION:-us-east-1}"
PROD_DB_INSTANCE="tariffshield-prod"
TEMP_DB_INSTANCE="tariffshield-dr-test-$(date +%s)"
TEMP_DB_SUBNET_GROUP="${TEMP_DB_SUBNET_GROUP:-default-postgres}"
DRILL_DATE=$(date -u '+%Y-%m-%d %H:%M:%SZ')
DRILL_REPORT_FILE="${DRILL_REPORT_FILE:-dr-drill-${DRILL_DATE}.json}"
DB_USER="${DB_USER:-tariffshield}"
DB_NAME="${DB_NAME:-tariffshield}"
DB_PASSWORD="${DB_PASSWORD:-}"
REPORT_MODE="live"
DRILL_NOTES="Quarterly DR drill - restoration and validation successful"

# Tables the restored schema must contain (also emitted by the dry-run psql shim)
EXPECTED_TABLES=("users" "importers" "tariff_uploads" "contract_events" "oracle_alerts" "aml_screenings" "security_incidents" "data_erasure_requests")

if [ "$DRY_RUN" = "true" ]; then
  TEMP_DB_INSTANCE="tariffshield-dr-test-dry-run"
  REPORT_MODE="dry-run"
  DRILL_NOTES="Local dry run - canned aws/psql data; no instance was created or deleted"
  echo "[INFO] DR Drill started at $DRILL_DATE (dry-run: mocked aws/psql, canned data)"
else
  echo "[INFO] DR Drill started at $DRILL_DATE"
fi
echo "[INFO] Temporary instance: $TEMP_DB_INSTANCE"

# ── aws shim ────────────────────────────────────────────────────────────────
# In dry-run mode the read-only `aws` lookups return canned values so the
# drill's control flow can run without credentials. Mutating calls (restore,
# wait, delete, upload, put-item) are skipped explicitly at their call sites.
aws() {
  if [ "$DRY_RUN" != "true" ]; then
    command aws "$@"
    return
  fi

  local args="$*"
  case "$args" in
    *describe-db-snapshots*)
      echo "rds:tariffshield-prod-2026-01-01-00-00"
      ;;
    *describe-db-instances*Endpoint.Address*)
      echo "tariffshield-dr-test.example.us-east-1.rds.amazonaws.com"
      ;;
    *describe-db-instances*Endpoint.Port*)
      echo "5432"
      ;;
    *)
      echo "[dry-run] would run: aws $args"
      ;;
  esac
}

# ── psql shim ───────────────────────────────────────────────────────────────
# Dry-run mode has no reachable restored instance, so validation queries return
# canned results. The expected table list is printed verbatim so the schema
# check below still executes against it.
psql() {
  if [ "$DRY_RUN" != "true" ]; then
    command psql "$@"
    return
  fi

  local sql="" prev=""
  for arg in "$@"; do
    if [ "$prev" = "-c" ] || [ "$prev" = "-tc" ]; then
      sql="$arg"
    fi
    prev="$arg"
  done

  case "$sql" in
    "SELECT 1")
      return 0
      ;;
    *information_schema.tables*)
      printf '%s\n' "${EXPECTED_TABLES[@]}"
      ;;
    *"COUNT(*) FROM users"*)
      echo "3"
      ;;
    *"COUNT(*) FROM importers WHERE"*)
      echo "2"
      ;;
    *"COUNT(*) FROM importers"*)
      echo "2"
      ;;
    *"COUNT(*) FROM contract_events"*)
      echo "6"
      ;;
    *)
      echo "0"
      ;;
  esac
}

# Step 1: Find latest encrypted snapshot
echo "[INFO] Locating latest encrypted snapshot..."
LATEST_SNAPSHOT=$(aws rds describe-db-snapshots \
  --region "$REGION" \
  --db-instance-identifier "$PROD_DB_INSTANCE" \
  --query 'sort_by(DBSnapshots[?StorageEncrypted==`true`], &CreateTime)[-1].DBSnapshotIdentifier' \
  --output text)

if [ -z "$LATEST_SNAPSHOT" ] || [ "$LATEST_SNAPSHOT" = "None" ]; then
  echo "[ERROR] No encrypted snapshots found for $PROD_DB_INSTANCE"
  exit 1
fi

echo "[INFO] Using snapshot: $LATEST_SNAPSHOT"

# Step 2: Restore to temporary instance
if [ "$DRY_RUN" = "true" ]; then
  echo "[INFO] [dry-run] Skipping snapshot restore; no instance is created"
else
  echo "[INFO] Restoring snapshot to temporary instance: $TEMP_DB_INSTANCE"
  aws rds restore-db-instance-from-db-snapshot \
    --region "$REGION" \
    --db-instance-identifier "$TEMP_DB_INSTANCE" \
    --db-snapshot-identifier "$LATEST_SNAPSHOT" \
    --publicly-accessible false \
    --multi-az false \
    --enable-cloudwatch-logs-exports postgresql

  echo "[INFO] Waiting for temporary instance to be available (may take 5-10 minutes)..."
  aws rds wait db-instance-available \
    --region "$REGION" \
    --db-instance-identifier "$TEMP_DB_INSTANCE"

  echo "[INFO] Temporary instance is available"
fi

# Step 3: Get temporary instance endpoint
TEMP_ENDPOINT=$(aws rds describe-db-instances \
  --region "$REGION" \
  --db-instance-identifier "$TEMP_DB_INSTANCE" \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

TEMP_PORT=$(aws rds describe-db-instances \
  --region "$REGION" \
  --db-instance-identifier "$TEMP_DB_INSTANCE" \
  --query 'DBInstances[0].Endpoint.Port' \
  --output text)

echo "[INFO] Temporary instance endpoint: $TEMP_ENDPOINT:$TEMP_PORT"

# Step 4: Validate schema decryptability (attempt connection)
echo "[INFO] Validating restored database is decryptable and accessible..."
export PGPASSWORD="$DB_PASSWORD"

# Retry loop for connection (instance may need a moment to fully boot)
RETRIES=5
for i in $(seq 1 $RETRIES); do
  if psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -c "SELECT 1" >/dev/null 2>&1; then
    echo "[INFO] Database connection successful on attempt $i"
    break
  fi
  if [ $i -eq $RETRIES ]; then
    echo "[ERROR] Failed to connect to temporary instance after $RETRIES attempts"
    exit 1
  fi
  sleep 10
done

# Step 5: Validate schema
echo "[INFO] Validating schema integrity..."
TABLES=$(psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -tc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;")

MISSING_TABLES=()

for expected in "${EXPECTED_TABLES[@]}"; do
  if ! echo "$TABLES" | grep -q "^$expected$"; then
    MISSING_TABLES+=("$expected")
  fi
done

if [ ${#MISSING_TABLES[@]} -gt 0 ]; then
  echo "[ERROR] Missing tables: ${MISSING_TABLES[*]}"
  exit 1
fi

echo "[INFO] All expected tables present"

# Step 6: Validate critical data integrity
echo "[INFO] Validating critical data row counts and formats..."

# Check users table
USER_COUNT=$(psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -tc \
  "SELECT COUNT(*) FROM users;" | tr -d ' ')
echo "[INFO] Users table: $USER_COUNT rows"

# Check importers table and EIN format (if any)
IMPORTERS_VALID=$(psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -tc \
  "SELECT COUNT(*) FROM importers WHERE ein IS NULL OR ein ~ '^\d{2}-\d{7}$';" | tr -d ' ')
IMPORTERS_TOTAL=$(psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -tc \
  "SELECT COUNT(*) FROM importers;" | tr -d ' ')

if [ "$IMPORTERS_TOTAL" -gt 0 ] && [ "$IMPORTERS_VALID" -ne "$IMPORTERS_TOTAL" ]; then
  echo "[ERROR] EIN format validation failed: $IMPORTERS_VALID/$IMPORTERS_TOTAL valid"
  exit 1
fi

echo "[INFO] Importers table: $IMPORTERS_TOTAL rows, EIN format valid"

# Check contract_events table
EVENTS_COUNT=$(psql -h "$TEMP_ENDPOINT" -U "$DB_USER" -d "$DB_NAME" -p "$TEMP_PORT" -tc \
  "SELECT COUNT(*) FROM contract_events;" | tr -d ' ')
echo "[INFO] Contract events table: $EVENTS_COUNT rows"

# Step 7: Decrypt and verify export file (if available)
if [ "$DRY_RUN" = "true" ] && [ -n "${DR_EXPORT_S3_KEY:-}" ]; then
  echo "[INFO] [dry-run] Skipping encrypted export validation for $DR_EXPORT_S3_KEY"
elif [ -n "${DR_EXPORT_S3_KEY:-}" ]; then
  echo "[INFO] Validating encrypted backup export file..."

  # Retrieve encryption key from Secrets Manager
  ENCRYPTION_KEY=$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id tariffshield-backup-encryption-key \
    --query 'SecretString' \
    --output text)

  # Download and decrypt export (example - adjust for actual encryption method)
  aws s3 cp "s3://tariffshield-dr-exports/${DR_EXPORT_S3_KEY}" - | \
    openssl enc -aes-256-cbc -d -K "$ENCRYPTION_KEY" -p | \
    gzip -dc | head -100 >/dev/null

  echo "[INFO] Export file decryption successful"
fi

# Step 8: Generate drill report
DRILL_STATUS="PASSED"
REPORT_JSON=$(cat <<EOF
{
  "drill_timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "mode": "$REPORT_MODE",
  "status": "$DRILL_STATUS",
  "source_snapshot": "$LATEST_SNAPSHOT",
  "temp_instance": "$TEMP_DB_INSTANCE",
  "temp_endpoint": "$TEMP_ENDPOINT",
  "validation": {
    "connection": "OK",
    "schema_completeness": "OK",
    "table_count": ${#EXPECTED_TABLES[@]},
    "user_count": $USER_COUNT,
    "importer_count": $IMPORTERS_TOTAL,
    "contract_events_count": $EVENTS_COUNT,
    "ein_format_validation": "OK"
  },
  "notes": "$DRILL_NOTES"
}
EOF
)

echo "$REPORT_JSON" | tee "$DRILL_REPORT_FILE"

# Step 9: Upload report to S3 for auditor review
if [ "$DRY_RUN" = "true" ]; then
  echo "[INFO] [dry-run] Skipping upload of $DRILL_REPORT_FILE to S3"
else
  echo "[INFO] Uploading drill report to S3..."
  aws s3 cp "$DRILL_REPORT_FILE" "s3://tariffshield-compliance/dr-drills/$DRILL_REPORT_FILE"
fi

# Step 10: Record drill in DynamoDB
if [ "$DRY_RUN" = "true" ]; then
  echo "[INFO] [dry-run] Skipping DynamoDB drill record"
else
  echo "[INFO] Recording drill event..."
  aws dynamodb put-item \
    --region "$REGION" \
    --table-name backup-drills \
    --item "{
      \"drill_id\": {\"S\": \"$(date -u '+%Y-%m-%d')\"},
      \"drill_timestamp\": {\"S\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"},
      \"source_snapshot\": {\"S\": \"$LATEST_SNAPSHOT\"},
      \"status\": {\"S\": \"$DRILL_STATUS\"},
      \"temp_instance\": {\"S\": \"$TEMP_DB_INSTANCE\"},
      \"report_s3_key\": {\"S\": \"dr-drills/$DRILL_REPORT_FILE\"}
    }"
fi

# Step 11: Delete temporary instance
if [ "$DRY_RUN" = "true" ]; then
  echo "[INFO] [dry-run] Skipping deletion of $TEMP_DB_INSTANCE (no instance was created)"
else
  echo "[INFO] Deleting temporary instance $TEMP_DB_INSTANCE..."
  aws rds delete-db-instance \
    --region "$REGION" \
    --db-instance-identifier "$TEMP_DB_INSTANCE" \
    --skip-final-snapshot
fi

if [ "$DRY_RUN" = "true" ]; then
  echo "[INFO] DR drill dry-run completed successfully (no AWS resources touched)"
else
  echo "[INFO] DR drill completed successfully"
fi
echo "[INFO] Report: $DRILL_REPORT_FILE"
