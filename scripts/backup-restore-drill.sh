#!/bin/bash

set -euo pipefail

# Quarterly disaster recovery drill script
# Restores from latest encrypted backup, validates schema and data, then deletes temporary instance

REGION="${AWS_REGION:-us-east-1}"
PROD_DB_INSTANCE="tariffshield-prod"
TEMP_DB_INSTANCE="tariffshield-dr-test-$(date +%s)"
TEMP_DB_SUBNET_GROUP="${TEMP_DB_SUBNET_GROUP:-default-postgres}"
DRILL_DATE=$(date -u '+%Y-%m-%d %H:%M:%SZ')
DRILL_REPORT_FILE="dr-drill-${DRILL_DATE}.json"

echo "[INFO] DR Drill started at $DRILL_DATE"
echo "[INFO] Temporary instance: $TEMP_DB_INSTANCE"

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

EXPECTED_TABLES=("users" "importers" "tariff_uploads" "contract_events" "oracle_alerts" "aml_screenings" "security_incidents" "data_erasure_requests")
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
if [ -n "${DR_EXPORT_S3_KEY:-}" ]; then
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
  "notes": "Quarterly DR drill - restoration and validation successful"
}
EOF
)

echo "$REPORT_JSON" | tee "$DRILL_REPORT_FILE"

# Step 9: Upload report to S3 for auditor review
echo "[INFO] Uploading drill report to S3..."
aws s3 cp "$DRILL_REPORT_FILE" "s3://tariffshield-compliance/dr-drills/$DRILL_REPORT_FILE"

# Step 10: Record drill in DynamoDB
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

# Step 11: Delete temporary instance
echo "[INFO] Deleting temporary instance $TEMP_DB_INSTANCE..."
aws rds delete-db-instance \
  --region "$REGION" \
  --db-instance-identifier "$TEMP_DB_INSTANCE" \
  --skip-final-snapshot

echo "[INFO] DR drill completed successfully"
echo "[INFO] Report: $DRILL_REPORT_FILE"
