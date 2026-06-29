# US Data Residency Configuration — Issue #320

## Overview

TariffShield enforces strict US data residency: all PII (importer EINs, financial records) must be stored and processed exclusively in `us-east-1` or `us-west-2`.

## Files

| File | Purpose |
|------|---------|
| `scp-deny-non-us-regions.json` | AWS Organizations SCP — denies resource creation outside US regions |
| `s3-bucket-policy-us-only.json` | S3 bucket policy template — deny access from non-US regions + enforce TLS |
| `audit-data-residency.sh` | Quarterly audit script — scans RDS, S3, EC2 for out-of-region resources |

## Applying the SCP

```bash
# Create the SCP in AWS Organizations
aws organizations create-policy \
  --name "DenyNonUSRegions" \
  --type SERVICE_CONTROL_POLICY \
  --content file://scp-deny-non-us-regions.json \
  --description "Deny resource creation outside us-east-1 and us-west-2"

# Attach to the TariffShield account
aws organizations attach-policy \
  --policy-id <POLICY_ID> \
  --target-id <ACCOUNT_ID>
```

## Applying S3 Bucket Policy

Replace `BUCKET_NAME` in `s3-bucket-policy-us-only.json` for each bucket, then:

```bash
aws s3api put-bucket-policy \
  --bucket <BUCKET_NAME> \
  --policy file://s3-bucket-policy-us-only.json
```

Disable cross-region replication on all buckets:

```bash
aws s3api delete-bucket-replication --bucket <BUCKET_NAME>
```

## VPC Flow Logs + GuardDuty

Enable VPC Flow Logs for egress monitoring:

```bash
aws ec2 create-flow-logs \
  --resource-type VPC \
  --resource-ids <VPC_ID> \
  --traffic-type ALL \
  --log-destination-type cloud-watch-logs \
  --log-group-name /tariffshield/vpc-flow-logs \
  --deliver-logs-permission-arn <FLOW_LOGS_IAM_ROLE_ARN>

# Enable GuardDuty
aws guardduty create-detector --enable --finding-publishing-frequency FIFTEEN_MINUTES
```

## Quarterly Audit

Run `audit-data-residency.sh` quarterly (or schedule via EventBridge):

```bash
./audit-data-residency.sh --profile tariffshield-prod
```

The script exits non-zero if any out-of-region resources are found. Integrate with the compliance dashboard by parsing the generated JSON report.

## Third-Party DPA Requirements

All third-party integrations receiving PII (DocuSign, Chainalysis, KYC providers) must provide a signed Data Processing Agreement (DPA) confirming US-only data handling. Maintain DPAs in the legal register and review annually.

## Code-Level Enforcement

`apps/api/src/db.ts` identifies all PII-bearing tables. The residency policy applies to the database host (`DATABASE_URL`) which must resolve to an RDS instance in `us-east-1` or `us-west-2`. This is validated at deploy time via the SCP above.
