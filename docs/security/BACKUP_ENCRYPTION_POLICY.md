# Backup Encryption and Secure Deletion Policy

Implements SOC 2 Type II CC9.1 (Risk Mitigation) and ISO 27001 Annex A.12.3 (Information Backup) requirements.

## Scope

This policy covers all database backups containing sensitive data:
- Importer EINs and legal names
- Financial records (bond IDs, collateral amounts)
- KYC document references
- Stellar wallet secrets (encrypted)
- AML screening results

## Encryption Strategy

### RDS Automated Backups and Snapshots

All automated daily snapshots and manual snapshots must be encrypted with the same KMS Customer Master Key (CMK) that encrypts the production RDS instance.

**Verification Command:**
```bash
aws rds describe-db-snapshots \
  --query 'DBSnapshots[*].[DBSnapshotIdentifier,StorageEncrypted,KmsKeyId]' \
  --region us-east-1
```

All snapshots must show `StorageEncrypted: true` with a consistent `KmsKeyId`.

### Database Exports

All pg_dump exports used for disaster recovery drills must be encrypted at the application level before storage in S3.

**Encryption:**
- Algorithm: AES-256-GCM
- Key management: AWS Secrets Manager (separate from RDS encryption key)
- Export format: `.sql.gz.encrypted`

## Backup Retention Policy

| Backup Type | Frequency | Retention | Deletion |
|---|---|---|---|
| Daily snapshots | Automated | 7 days | Automatic after 7 days |
| Weekly snapshots | Automated (first-of-week) | 4 weeks | Automatic after 28 days |
| Monthly snapshots | Automated (first-of-month) | 12 months | Automatic after 365 days |
| Export/DR drills | Manual, quarterly | Tied to data retention schedule (issue 313) | Secure delete after retention window |

### Automated Retention with AWS Backup

AWS Backup lifecycle policies manage snapshot pruning:

```json
{
  "BackupPlanName": "TariffShield-Database-Backup",
  "Rules": [
    {
      "RuleName": "DailyBackups",
      "TargetBackupVault": "tariffshield-encrypted-vault",
      "ScheduleExpression": "cron(0 2 ? * * *)",
      "StartWindowMinutes": 60,
      "CompletionWindowMinutes": 120,
      "Lifecycle": {
        "DeleteAfterDays": 7,
        "MoveToColdStorageAfterDays": null
      }
    },
    {
      "RuleName": "WeeklyBackups",
      "TargetBackupVault": "tariffshield-encrypted-vault",
      "ScheduleExpression": "cron(0 3 ? * MON *)",
      "Lifecycle": {
        "DeleteAfterDays": 28
      }
    },
    {
      "RuleName": "MonthlyBackups",
      "TargetBackupVault": "tariffshield-encrypted-vault",
      "ScheduleExpression": "cron(0 4 1 * ? *)",
      "Lifecycle": {
        "DeleteAfterDays": 365
      }
    }
  ]
}
```

## S3 Object Lock for Compliance Holds

Backup buckets use S3 Object Lock (Governance mode) to prevent premature deletion:

```bash
aws s3api put-object-lock-configuration \
  --bucket tariffshield-backups \
  --object-lock-configuration \
  ObjectLockEnabled=Enabled,Rule='{DefaultRetention={Mode=GOVERNANCE,Days=7}}'
```

Governance mode allows authorized users to reduce retention if needed, satisfying regulatory requirements for controlled modification.

## Secure Deletion Procedures

### Lambda-Based Snapshot Pruning

Automated Lambda function (runs daily):
- Queries RDS snapshots beyond retention window
- Verifies snapshot encryption status
- Logs deletion intention to CloudTrail
- Deletes snapshot
- Records deletion event to DynamoDB audit table

**Environment variables:**
- `RETENTION_DAYS_DAILY`: 7
- `RETENTION_DAYS_WEEKLY`: 28
- `RETENTION_DAYS_MONTHLY`: 365

### Secure Deletion of Exports

PostgreSQL export files in S3 are deleted via:
- S3 API `DeleteObject` (overwrites with zeros on deletion)
- File pointer cryptographic erasure (overwrite key in Secrets Manager)

**Manual cleanup command:**
```bash
# List expired exports
aws s3api list-objects-v2 \
  --bucket tariffshield-dr-exports \
  --prefix exports/ \
  --query "Contents[?LastModified<'2023-12-01']"

# Secure delete (CloudTrail logs the deletion)
aws s3api delete-object \
  --bucket tariffshield-dr-exports \
  --key exports/backup-2023-11-15.sql.gz.encrypted
```

## Compliance Auditing

### Monthly Backup Evidence Report

Generated via Lambda function, exported to S3 for SOC 2 auditor review:

```json
{
  "report_date": "2024-06-27",
  "rds_snapshots": {
    "total_count": 42,
    "oldest_age_days": 6,
    "all_encrypted": true,
    "kms_key_id": "arn:aws:kms:us-east-1:ACCOUNT:key/KEY-ID",
    "snapshots": [
      {
        "id": "rds:tariffshield-prod-2024-06-27-02-00",
        "created_at": "2024-06-27T02:00:00Z",
        "encrypted": true,
        "size_gb": 12.5
      }
    ]
  },
  "s3_exports": {
    "total_count": 4,
    "oldest_age_days": 32,
    "all_encrypted": true,
    "exports": [
      {
        "key": "exports/backup-2024-06-27.sql.gz.encrypted",
        "created_at": "2024-06-27T03:15:00Z",
        "size_bytes": 45678900,
        "encryption": "AES-256-GCM"
      }
    ]
  },
  "deletion_events": {
    "last_30_days": 8,
    "last_event": "2024-06-26T04:30:00Z",
    "events": [
      {
        "resource": "rds:tariffshield-prod-2024-05-27-02-00",
        "type": "snapshot",
        "deleted_at": "2024-06-26T04:30:00Z",
        "deleted_by_role": "arn:aws:iam::ACCOUNT:role/tariffshield-backup-cleanup",
        "cloudtrail_event_id": "abc123"
      }
    ]
  }
}
```

**Verification command:**
```bash
aws s3 cp s3://tariffshield-compliance/backup-report-2024-06.json - | jq .
```

## Disaster Recovery Drill Procedure

Quarterly (every 90 days):

1. Retrieve encrypted export from S3
2. Decrypt using Secrets Manager key
3. Restore to temporary RDS instance (same VPC, different security group)
4. Run schema validation queries
5. Verify critical table row counts match production
6. Verify no data corruption (e.g., EIN format validation)
7. Document results in DynamoDB table `backup_drills`
8. Delete temporary instance

**Script:** See `scripts/backup-restore-drill.sh`

## Authorization and Responsibilities

- **Platform Admin**: Initiates manual snapshot creation
- **AWS Account Owner**: Configures AWS Backup policies and KMS permissions
- **CloudTrail**: Records all deletion actions
- **SOC 2 Auditor**: Reviews monthly compliance report

## Related Issues

- Issue #313: Data retention and secure erasure schedule
- Issue #314: Encryption key rotation policy (annual, minimum)
- Issue #312: RDS security group and network isolation

## Compliance Standards

- **SOC 2 Type II CC9.1**: Risk Mitigation - backup confidentiality and availability
- **ISO 27001 A.12.3**: Information backup controls
- **State Breach Notification Laws**: Data breach triggers backup breach notification
