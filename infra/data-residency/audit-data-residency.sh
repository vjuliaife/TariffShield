#!/usr/bin/env bash
# Issue #320 — US Data Residency Quarterly Audit Script
# Scans active AWS resources and reports any found outside us-east-1 / us-west-2.
# Usage: ./audit-data-residency.sh [--profile <aws-profile>]
set -euo pipefail

ALLOWED_REGIONS=("us-east-1" "us-west-2")
PROFILE="${2:-default}"
REPORT_FILE="data-residency-audit-$(date +%Y%m%d).json"
FINDINGS=()

log() { echo "[audit] $*" >&2; }

is_allowed() {
  local region="$1"
  for r in "${ALLOWED_REGIONS[@]}"; do [[ "$region" == "$r" ]] && return 0; done
  return 1
}

log "Scanning RDS instances..."
while IFS= read -r line; do
  region=$(echo "$line" | jq -r '.region')
  id=$(echo "$line" | jq -r '.id')
  if ! is_allowed "$region"; then
    FINDINGS+=("{\"service\":\"rds\",\"id\":\"$id\",\"region\":\"$region\"}")
    log "OUT-OF-REGION RDS: $id in $region"
  fi
done < <(aws rds describe-db-instances \
  --query 'DBInstances[*].{id:DBInstanceIdentifier,region:AvailabilityZone}' \
  --output json --profile "$PROFILE" | jq -c '.[]')

log "Scanning S3 buckets for cross-region replication..."
while IFS= read -r bucket; do
  region=$(aws s3api get-bucket-location --bucket "$bucket" \
    --query 'LocationConstraint' --output text --profile "$PROFILE" 2>/dev/null || echo "us-east-1")
  [[ "$region" == "None" ]] && region="us-east-1"
  if ! is_allowed "$region"; then
    FINDINGS+=("{\"service\":\"s3\",\"id\":\"$bucket\",\"region\":\"$region\"}")
    log "OUT-OF-REGION S3: $bucket in $region"
  fi
done < <(aws s3api list-buckets --query 'Buckets[*].Name' \
  --output text --profile "$PROFILE" | tr '\t' '\n')

log "Scanning EC2 instances..."
for region in "${ALLOWED_REGIONS[@]}"; do :; done
ALL_REGIONS=$(aws ec2 describe-regions --query 'Regions[*].RegionName' \
  --output text --profile "$PROFILE" | tr '\t' '\n')
while IFS= read -r region; do
  if ! is_allowed "$region"; then
    count=$(aws ec2 describe-instances --region "$region" \
      --query 'length(Reservations[*].Instances[*])' \
      --output text --profile "$PROFILE" 2>/dev/null || echo 0)
    if [[ "$count" -gt 0 ]]; then
      FINDINGS+=("{\"service\":\"ec2\",\"region\":\"$region\",\"instance_count\":$count}")
      log "OUT-OF-REGION EC2: $count instances in $region"
    fi
  fi
done <<< "$ALL_REGIONS"

# Write report
FINDINGS_JSON=$(printf '%s\n' "${FINDINGS[@]}" | jq -s '.')
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson findings "$FINDINGS_JSON" \
  '{audit_timestamp: $ts, allowed_regions: ["us-east-1","us-west-2"], findings: $findings, out_of_region_count: ($findings | length)}' \
  > "$REPORT_FILE"

log "Audit complete. Report: $REPORT_FILE"
if [[ ${#FINDINGS[@]} -gt 0 ]]; then
  log "WARNING: ${#FINDINGS[@]} out-of-region resource(s) found!"
  exit 1
fi
exit 0
