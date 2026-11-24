/**
 * scripts/lib/invoke-lambda-local.ts
 *
 * Local invocation helper for TariffShield AWS Lambda handlers:
 * - scripts/backup-cleanup-lambda.ts
 * - scripts/backup-compliance-report-lambda.ts
 *
 * Provides a clean test harness for local development, dry-run smoke tests,
 * and automated regression tests without requiring AWS SAM, CDK, or AWS credentials.
 *
 * Usage:
 *   npx tsx scripts/lib/invoke-lambda-local.ts cleanup --dry-run
 *   npx tsx scripts/lib/invoke-lambda-local.ts compliance-report --dry-run
 */

import Module from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MockLambdaContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
  done: (error?: Error | null, result?: any) => void;
  fail: (error: Error | string) => void;
  succeed: (messageOrObject: any) => void;
}

export interface MockDBSnapshot {
  DBSnapshotIdentifier?: string;
  CreateTime?: Date;
  StorageEncrypted?: boolean;
  KmsKeyId?: string;
  AllocatedStorage?: number;
  Status?: string;
  Engine?: string;
}

export interface MockS3Object {
  Key?: string;
  LastModified?: Date;
  Size?: number;
  ETag?: string;
}

export interface MockDynamoItem {
  [key: string]: {
    S?: string;
    N?: string;
    BOOL?: boolean;
  };
}

export interface MockAwsData {
  snapshots: MockDBSnapshot[];
  s3Objects: MockS3Object[];
  auditItems: MockDynamoItem[];
  deletedSnapshots: string[];
  uploadedObjects: Array<{ bucket: string; key: string; body: string }>;
  putAuditItems: MockDynamoItem[];
}

export interface LocalInvokeOptions {
  target: 'cleanup' | 'compliance-report';
  dryRun?: boolean;
  event?: Record<string, any>;
  context?: Partial<MockLambdaContext>;
  customMockData?: Partial<MockAwsData>;
}

export interface LocalInvokeResult<T = any> {
  target: 'cleanup' | 'compliance-report';
  dryRun: boolean;
  output: T;
  durationMs: number;
  mockState?: {
    deletedSnapshots: string[];
    uploadedObjectsCount: number;
    auditRecordsCount: number;
  };
}

/**
 * Creates default representative synthetic AWS data for local dry-run tests.
 */
export function getDefaultMockAwsData(): MockAwsData {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const recentDateStr = new Date(now - 2 * dayMs).toISOString().slice(0, 10);

  return {
    snapshots: [
      {
        DBSnapshotIdentifier: 'tariffshield-prod-2024-01-01',
        CreateTime: new Date(now - 35 * dayMs), // 35 days old (> 7 days policy: EXPIRED)
        StorageEncrypted: true,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/mock-kms-key',
        AllocatedStorage: 100,
        Status: 'available',
        Engine: 'postgres',
      },
      {
        DBSnapshotIdentifier: 'tariffshield-weekly-2024-01-01',
        CreateTime: new Date(now - 45 * dayMs), // 45 days old (> 28 days policy: EXPIRED)
        StorageEncrypted: true,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/mock-kms-key',
        AllocatedStorage: 100,
        Status: 'available',
        Engine: 'postgres',
      },
      {
        DBSnapshotIdentifier: `tariffshield-prod-${recentDateStr}`,
        CreateTime: new Date(now - 2 * dayMs), // 2 days old (NOT expired, policy: 7 days)
        StorageEncrypted: true,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/mock-kms-key',
        AllocatedStorage: 100,
        Status: 'available',
        Engine: 'postgres',
      },
      {
        DBSnapshotIdentifier: 'manual-unmanaged-backup',
        CreateTime: new Date(now - 100 * dayMs), // No policy match
        StorageEncrypted: true,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/mock-kms-key',
        AllocatedStorage: 50,
        Status: 'available',
        Engine: 'postgres',
      },
    ],
    s3Objects: [
      {
        Key: 'exports/postgres-export-2024-01-01.tar.gz',
        LastModified: new Date(now - 14 * dayMs),
        Size: 10485760,
        ETag: '"mock-export-etag-1"',
      },
      {
        Key: 'exports/postgres-export-recent.tar.gz',
        LastModified: new Date(now - 1 * dayMs),
        Size: 10485760,
        ETag: '"mock-export-etag-2"',
      },
    ],
    auditItems: [
      {
        resource_id: { S: 'tariffshield-prod-2023-12-01' },
        resource_type: { S: 'rds-snapshot' },
        deleted_at: { S: new Date(now - 10 * dayMs).toISOString() },
        deleted_by_role: { S: 'arn:aws:iam::123456789012:role/TariffShieldBackupCleanup' },
        cloudtrail_event_id: { S: 'mock-cloudtrail-evt-001' },
      },
    ],
    deletedSnapshots: [],
    uploadedObjects: [],
    putAuditItems: [],
  };
}

/**
 * Creates a representative mock Lambda context.
 */
export function createMockLambdaContext(functionName = 'local-lambda-runner'): MockLambdaContext {
  const startTime = Date.now();
  const timeoutMs = 30000;

  return {
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
    memoryLimitInMB: '256',
    awsRequestId: `mock-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: `2026/10/18/[$LATEST]${Math.random().toString(16).substring(2, 10)}`,
    getRemainingTimeInMillis: () => Math.max(0, timeoutMs - (Date.now() - startTime)),
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/**
 * Creates a representative mock CloudWatch/EventBridge scheduled event.
 */
export function createMockLambdaEvent(
  target: 'cleanup' | 'compliance-report'
): Record<string, any> {
  return {
    version: '0',
    id: `evt-${Date.now()}`,
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: new Date().toISOString(),
    region: process.env.AWS_REGION || 'us-east-1',
    resources: [`arn:aws:events:us-east-1:123456789012:rule/tariffshield-${target}-schedule`],
    detail: {
      dryRun: true,
      invokedBy: 'invoke-lambda-local',
    },
  };
}

let activeMockData: MockAwsData = getDefaultMockAwsData();

/**
 * Updates the globally active mock AWS dataset.
 */
export function setActiveMockData(data: MockAwsData): void {
  activeMockData = data;
}

/**
 * Intercepts Node module loading for @aws-sdk packages and provides mock clients.
 * This guarantees local execution works even when @aws-sdk packages are not installed,
 * and eliminates the need for real AWS credentials.
 */
export function installAwsMock(mockData: MockAwsData): () => void {
  setActiveMockData(mockData);

  // Populate fallback environment variables
  const prevEnv = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AUDIT_TABLE_NAME: process.env.AUDIT_TABLE_NAME,
    BACKUP_BUCKET: process.env.BACKUP_BUCKET,
    COMPLIANCE_BUCKET: process.env.COMPLIANCE_BUCKET,
    KMS_KEY_ID: process.env.KMS_KEY_ID,
    AWS_EXECUTION_ROLE_ARN: process.env.AWS_EXECUTION_ROLE_ARN,
  };

  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'mock-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'mock-secret-access-key';
  process.env.AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || 'backup-deletion-events';
  process.env.BACKUP_BUCKET = process.env.BACKUP_BUCKET || 'tariffshield-dr-exports';
  process.env.COMPLIANCE_BUCKET = process.env.COMPLIANCE_BUCKET || 'tariffshield-compliance';
  process.env.KMS_KEY_ID =
    process.env.KMS_KEY_ID || 'arn:aws:kms:us-east-1:123456789012:key/mock-key';
  process.env.AWS_EXECUTION_ROLE_ARN =
    process.env.AWS_EXECUTION_ROLE_ARN ||
    'arn:aws:iam::123456789012:role/TariffShieldLambdaExecution';

  class MockRDSClient {
    async send(command: any) {
      const name = command?.constructor?.name || command?.name || '';
      if (name.includes('DescribeDBSnapshots') || command?.input?.Filters) {
        return {
          DBSnapshots: activeMockData.snapshots.map((s) => ({ ...s })),
        };
      }
      if (name.includes('DeleteDBSnapshot') || command?.input?.DBSnapshotIdentifier) {
        const id = command.input.DBSnapshotIdentifier;
        activeMockData.deletedSnapshots.push(id);
        return {
          DBSnapshot: {
            DBSnapshotIdentifier: id,
            Status: 'deleted',
          },
        };
      }
      return {};
    }
  }

  class MockDynamoDBClient {
    async send(command: any) {
      const name = command?.constructor?.name || command?.name || '';
      if (name.includes('PutItem') || command?.input?.Item) {
        activeMockData.putAuditItems.push(command.input.Item);
        return {};
      }
      if (name.includes('Query') || command?.input?.KeyConditionExpression) {
        return {
          Items: activeMockData.auditItems.map((item) => ({ ...item })),
          Count: activeMockData.auditItems.length,
        };
      }
      return {};
    }
  }

  class MockS3Client {
    async send(command: any) {
      const name = command?.constructor?.name || command?.name || '';
      if (name.includes('ListObjects') || command?.input?.Prefix) {
        return {
          Contents: activeMockData.s3Objects.map((obj) => ({ ...obj })),
          IsTruncated: false,
        };
      }
      if (name.includes('PutObject') || (command?.input?.Bucket && command?.input?.Key)) {
        activeMockData.uploadedObjects.push({
          bucket: command.input.Bucket,
          key: command.input.Key,
          body: typeof command.input.Body === 'string' ? command.input.Body : '[binary/stream]',
        });
        return {
          ETag: '"mock-etag-' + Date.now() + '"',
        };
      }
      return {};
    }
  }

  class MockCloudTrailClient {
    async send(_command: any) {
      return { Events: [] };
    }
  }

  class MockCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }

  const mockRdsModule = {
    RDSClient: MockRDSClient,
    DescribeDBSnapshotsCommand: class DescribeDBSnapshotsCommand extends MockCommand {},
    DeleteDBSnapshotCommand: class DeleteDBSnapshotCommand extends MockCommand {},
  };

  const mockDynamoModule = {
    DynamoDBClient: MockDynamoDBClient,
    PutItemCommand: class PutItemCommand extends MockCommand {},
    QueryCommand: class QueryCommand extends MockCommand {},
  };

  const mockS3Module = {
    S3Client: MockS3Client,
    ListObjectsV2Command: class ListObjectsV2Command extends MockCommand {},
    PutObjectCommand: class PutObjectCommand extends MockCommand {},
  };

  const mockCloudTrailModule = {
    CloudTrailClient: MockCloudTrailClient,
    LookupEventsCommand: class LookupEventsCommand extends MockCommand {},
  };

  // Intercept module loader for @aws-sdk packages
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === '@aws-sdk/client-rds') return mockRdsModule;
    if (request === '@aws-sdk/client-dynamodb') return mockDynamoModule;
    if (request === '@aws-sdk/client-s3') return mockS3Module;
    if (request === '@aws-sdk/client-cloudtrail') return mockCloudTrailModule;
    return originalLoad.apply(this, arguments);
  };

  return function restoreAwsMock() {
    (Module as any)._load = originalLoad;
    // Restore previous environment variables
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  };
}

/**
 * Locally invokes a backup Lambda handler function.
 */
export async function invokeLambdaLocal<T = any>(
  options: LocalInvokeOptions
): Promise<LocalInvokeResult<T>> {
  const { target, dryRun = true, event, context, customMockData } = options;

  const mockData: MockAwsData = {
    ...getDefaultMockAwsData(),
    ...customMockData,
  };
  setActiveMockData(mockData);

  let restoreMock: (() => void) | null = null;
  if (dryRun) {
    restoreMock = installAwsMock(mockData);
  }

  const startTime = Date.now();
  try {
    const handlerEvent = event || createMockLambdaEvent(target);
    const handlerContext = { ...createMockLambdaContext(`backup-${target}-lambda`), ...context };

    let output: T;
    const cacheBuster = `?t=${Date.now()}_${Math.random().toString(36).substring(2)}`;

    if (target === 'cleanup') {
      const targetPath = path.resolve(__dirname, '../backup-cleanup-lambda.ts');
      const module = await import(pathToFileURL(targetPath).href + cacheBuster);
      output = await module.handler(handlerEvent, handlerContext);
    } else if (target === 'compliance-report') {
      const targetPath = path.resolve(__dirname, '../backup-compliance-report-lambda.ts');
      const module = await import(pathToFileURL(targetPath).href + cacheBuster);
      output = await module.handler(handlerEvent, handlerContext);
    } else {
      throw new Error(`Unknown target: ${target}. Must be 'cleanup' or 'compliance-report'.`);
    }

    const durationMs = Date.now() - startTime;
    return {
      target,
      dryRun,
      output,
      durationMs,
      mockState: dryRun
        ? {
            deletedSnapshots: [...mockData.deletedSnapshots],
            uploadedObjectsCount: mockData.uploadedObjects.length,
            auditRecordsCount: mockData.putAuditItems.length,
          }
        : undefined,
    };
  } finally {
    if (restoreMock) {
      restoreMock();
    }
  }
}

// CLI entrypoint
if (
  require.main === module ||
  (process.argv[1] && process.argv[1].endsWith('invoke-lambda-local.ts'))
) {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => !a.startsWith('--'));
  const isLive = args.includes('--live');
  const isJson = args.includes('--json');

  if (!targetArg || args.includes('--help') || args.includes('-h')) {
    console.log(`
TariffShield Local Lambda Invocation Tool

Usage:
  npx tsx scripts/lib/invoke-lambda-local.ts <target> [options]

Targets:
  cleanup              Run scripts/backup-cleanup-lambda.ts
  compliance-report    Run scripts/backup-compliance-report-lambda.ts

Options:
  --dry-run            (Default) Mock AWS calls with realistic synthetic test data; no credentials needed
  --live               Execute real AWS SDK calls using current environment credentials
  --json               Output result as raw JSON only

Examples:
  npx tsx scripts/lib/invoke-lambda-local.ts cleanup --dry-run
  npx tsx scripts/lib/invoke-lambda-local.ts compliance-report --dry-run
`);
    process.exit(targetArg ? 0 : 1);
  }

  const normalizedTarget =
    targetArg === 'cleanup' || targetArg === 'backup-cleanup'
      ? 'cleanup'
      : targetArg === 'compliance-report' || targetArg === 'backup-compliance-report'
        ? 'compliance-report'
        : null;

  if (!normalizedTarget) {
    console.error(
      `[ERROR] Invalid target "${targetArg}". Valid targets are 'cleanup' or 'compliance-report'.`
    );
    process.exit(1);
  }

  if (!isJson) {
    console.log(
      `[INFO] Invoking ${normalizedTarget} lambda locally (mode: ${isLive ? 'LIVE' : 'DRY-RUN'})...`
    );
  }

  invokeLambdaLocal({ target: normalizedTarget, dryRun: !isLive })
    .then((result) => {
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n[SUCCESS] Execution completed in ${result.durationMs}ms`);
        console.log('Handler output:');
        console.log(JSON.stringify(result.output, null, 2));
        if (result.mockState) {
          console.log('\nMock effects recorded:');
          console.log(
            `- Deleted snapshots: ${result.mockState.deletedSnapshots.length} (${result.mockState.deletedSnapshots.join(', ') || 'none'})`
          );
          console.log(`- Audit records created: ${result.mockState.auditRecordsCount}`);
          console.log(`- S3 objects uploaded: ${result.mockState.uploadedObjectsCount}`);
        }
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n[ERROR] Lambda invocation failed:', err);
      process.exit(1);
    });
}
