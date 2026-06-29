import { RDSClient, DescribeDBSnapshotsCommand, DeleteDBSnapshotCommand } from "@aws-sdk/client-rds";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";

const rds = new RDSClient({ region: process.env.AWS_REGION || "us-east-1" });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const cloudtrail = new CloudTrailClient({ region: process.env.AWS_REGION || "us-east-1" });

interface SnapshotPolicy {
  pattern: RegExp;
  retentionDays: number;
}

const SNAPSHOT_POLICIES: SnapshotPolicy[] = [
  { pattern: /tariffshield-prod-\d{4}-\d{2}-\d{2}/, retentionDays: 7 },
  { pattern: /tariffshield-weekly-\d{4}-\d{2}-\d{2}/, retentionDays: 28 },
  { pattern: /tariffshield-monthly-\d{4}-\d{2}-\d{2}/, retentionDays: 365 },
];

interface SnapshotToDelete {
  DBSnapshotIdentifier: string;
  CreateTime: Date;
  StorageEncrypted: boolean;
  KmsKeyId: string;
}

async function getExpiredSnapshots(): Promise<SnapshotToDelete[]> {
  const now = new Date();
  const snapshots = await rds.send(
    new DescribeDBSnapshotsCommand({
      Filters: [
        {
          Name: "engine",
          Values: ["postgres"],
        },
      ],
    })
  );

  const expired: SnapshotToDelete[] = [];

  for (const snapshot of snapshots.DBSnapshots || []) {
    if (!snapshot.DBSnapshotIdentifier || !snapshot.CreateTime || !snapshot.StorageEncrypted) {
      continue;
    }

    const policy = SNAPSHOT_POLICIES.find((p) => p.pattern.test(snapshot.DBSnapshotIdentifier));
    if (!policy) {
      console.log(`[INFO] Snapshot ${snapshot.DBSnapshotIdentifier} does not match any retention policy, skipping`);
      continue;
    }

    const ageMs = now.getTime() - snapshot.CreateTime.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    if (ageDays > policy.retentionDays) {
      expired.push({
        DBSnapshotIdentifier: snapshot.DBSnapshotIdentifier,
        CreateTime: snapshot.CreateTime,
        StorageEncrypted: snapshot.StorageEncrypted,
        KmsKeyId: snapshot.KmsKeyId || "unknown",
      });
    }
  }

  return expired;
}

async function deleteSnapshot(snapshotId: string): Promise<void> {
  console.log(`[INFO] Deleting snapshot ${snapshotId}...`);

  await rds.send(
    new DeleteDBSnapshotCommand({
      DBSnapshotIdentifier: snapshotId,
      SkipFinalSnapshot: true,
    })
  );

  console.log(`[INFO] Successfully deleted snapshot ${snapshotId}`);
}

async function logDeletionEvent(snapshot: SnapshotToDelete): Promise<void> {
  const now = new Date();

  await dynamodb.send(
    new PutItemCommand({
      TableName: process.env.AUDIT_TABLE_NAME || "backup-deletion-events",
      Item: {
        event_id: { S: `${snapshot.DBSnapshotIdentifier}-${now.getTime()}` },
        resource_id: { S: snapshot.DBSnapshotIdentifier },
        resource_type: { S: "rds-snapshot" },
        deleted_at: { S: now.toISOString() },
        deleted_by_role: { S: process.env.AWS_EXECUTION_ROLE_ARN || "unknown" },
        snapshot_age_days: { N: String(Math.floor((now.getTime() - snapshot.CreateTime.getTime()) / (1000 * 60 * 60 * 24))) },
        encrypted: { BOOL: snapshot.StorageEncrypted },
        kms_key_id: { S: snapshot.KmsKeyId },
      },
    })
  );
}

export async function handler(): Promise<{ deletedCount: number; errors: string[] }> {
  console.log("[INFO] Starting backup cleanup process...");

  try {
    const expired = await getExpiredSnapshots();
    console.log(`[INFO] Found ${expired.length} expired snapshots to delete`);

    let deletedCount = 0;
    const errors: string[] = [];

    for (const snapshot of expired) {
      try {
        await deleteSnapshot(snapshot.DBSnapshotIdentifier);
        await logDeletionEvent(snapshot);
        deletedCount++;
      } catch (err) {
        const errMsg = `Failed to delete ${snapshot.DBSnapshotIdentifier}: ${String(err)}`;
        console.error(`[ERROR] ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.log(`[INFO] Backup cleanup completed: ${deletedCount} snapshots deleted, ${errors.length} errors`);

    return {
      deletedCount,
      errors,
    };
  } catch (err) {
    console.error("[ERROR] Backup cleanup failed:", err);
    throw err;
  }
}
