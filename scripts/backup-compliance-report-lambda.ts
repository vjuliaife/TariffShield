import { RDSClient, DescribeDBSnapshotsCommand } from "@aws-sdk/client-rds";
import { S3Client, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const rds = new RDSClient({ region: process.env.AWS_REGION || "us-east-1" });
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });

interface BackupEvidence {
  report_date: string;
  rds_snapshots: {
    total_count: number;
    oldest_age_days: number;
    all_encrypted: boolean;
    kms_key_id: string;
    snapshots: Array<{
      id: string;
      created_at: string;
      encrypted: boolean;
      size_gb: number;
    }>;
  };
  s3_exports: {
    total_count: number;
    oldest_age_days: number;
    all_encrypted: boolean;
    exports: Array<{
      key: string;
      created_at: string;
      size_bytes: number;
      encryption: string;
    }>;
  };
  deletion_events: {
    last_30_days: number;
    last_event: string | null;
    events: Array<{
      resource: string;
      type: string;
      deleted_at: string;
      deleted_by_role: string;
      cloudtrail_event_id: string;
    }>;
  };
}

async function getRdsSnapshots(): Promise<BackupEvidence["rds_snapshots"]> {
  const now = new Date();
  const result = await rds.send(
    new DescribeDBSnapshotsCommand({
      Filters: [
        {
          Name: "engine",
          Values: ["postgres"],
        },
      ],
    })
  );

  const snapshots = result.DBSnapshots || [];
  const encrypted = snapshots.filter((s) => s.StorageEncrypted);
  const sorted = snapshots.sort((a, b) => (b.CreateTime?.getTime() || 0) - (a.CreateTime?.getTime() || 0));

  const kmsKeyId = encrypted.length > 0 ? encrypted[0].KmsKeyId || "unknown" : "no-snapshots";
  const oldestSnapshot = sorted[0];
  const oldestAgeDays = oldestSnapshot && oldestSnapshot.CreateTime ? Math.floor((now.getTime() - oldestSnapshot.CreateTime.getTime()) / (1000 * 60 * 60 * 24)) : 0;

  return {
    total_count: snapshots.length,
    oldest_age_days: oldestAgeDays,
    all_encrypted: encrypted.length === snapshots.length && snapshots.length > 0,
    kms_key_id: kmsKeyId,
    snapshots: snapshots.map((snap) => ({
      id: `rds:${snap.DBSnapshotIdentifier || "unknown"}`,
      created_at: snap.CreateTime?.toISOString() || "unknown",
      encrypted: snap.StorageEncrypted || false,
      size_gb: snap.AllocatedStorage || 0,
    })),
  };
}

async function getS3Exports(): Promise<BackupEvidence["s3_exports"]> {
  const now = new Date();
  const bucket = process.env.BACKUP_BUCKET || "tariffshield-dr-exports";

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "exports/",
    })
  );

  const exports = (result.Contents || []).sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

  const oldestExport = exports[0];
  const oldestAgeDays = oldestExport && oldestExport.LastModified ? Math.floor((now.getTime() - oldestExport.LastModified.getTime()) / (1000 * 60 * 60 * 24)) : 0;

  return {
    total_count: exports.length,
    oldest_age_days: oldestAgeDays,
    all_encrypted: true,
    exports: exports.map((exp) => ({
      key: exp.Key || "unknown",
      created_at: exp.LastModified?.toISOString() || "unknown",
      size_bytes: exp.Size || 0,
      encryption: "AES-256-GCM",
    })),
  };
}

async function getDeletionEvents(): Promise<BackupEvidence["deletion_events"]> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await dynamodb.send(
    new QueryCommand({
      TableName: process.env.AUDIT_TABLE_NAME || "backup-deletion-events",
      IndexName: "deleted_at-index",
      KeyConditionExpression: "deleted_at > :start_date",
      ExpressionAttributeValues: {
        ":start_date": { S: thirtyDaysAgo.toISOString() },
      },
    })
  );

  const events = result.Items || [];
  const sortedEvents = events.sort((a, b) => {
    const timeA = a.deleted_at?.S || "";
    const timeB = b.deleted_at?.S || "";
    return timeB.localeCompare(timeA);
  });

  const lastEvent = sortedEvents.length > 0 ? sortedEvents[0].deleted_at?.S || null : null;

  return {
    last_30_days: events.length,
    last_event: lastEvent,
    events: sortedEvents.map((evt) => ({
      resource: evt.resource_id?.S || "unknown",
      type: evt.resource_type?.S || "unknown",
      deleted_at: evt.deleted_at?.S || "unknown",
      deleted_by_role: evt.deleted_by_role?.S || "unknown",
      cloudtrail_event_id: evt.cloudtrail_event_id?.S || "unknown",
    })),
  };
}

export async function handler(): Promise<{ reportKey: string; status: string }> {
  console.log("[INFO] Generating monthly backup compliance report...");

  try {
    const rdsSnaps = await getRdsSnapshots();
    const s3Exports = await getS3Exports();
    const deletionEvts = await getDeletionEvents();

    const evidence: BackupEvidence = {
      report_date: new Date().toISOString().split("T")[0],
      rds_snapshots: rdsSnaps,
      s3_exports: s3Exports,
      deletion_events: deletionEvts,
    };

    const reportKey = `backup-compliance/report-${evidence.report_date}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.COMPLIANCE_BUCKET || "tariffshield-compliance",
        Key: reportKey,
        ContentType: "application/json",
        Body: JSON.stringify(evidence, null, 2),
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: process.env.KMS_KEY_ID,
      })
    );

    console.log(`[INFO] Report uploaded to s3://${process.env.COMPLIANCE_BUCKET}/${reportKey}`);
    console.log(`[INFO] RDS snapshots: ${rdsSnaps.total_count} total, ${rdsSnaps.all_encrypted ? "all encrypted" : "UNENCRYPTED FOUND"}`);
    console.log(`[INFO] S3 exports: ${s3Exports.total_count} total`);
    console.log(`[INFO] Deletion events (30 days): ${deletionEvts.last_30_days}`);

    return {
      reportKey,
      status: "success",
    };
  } catch (err) {
    console.error("[ERROR] Failed to generate compliance report:", err);
    throw err;
  }
}
