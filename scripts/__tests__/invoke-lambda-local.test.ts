/**
 * Regression and smoke tests for scripts/lib/invoke-lambda-local.ts
 *
 * Exercises local invocation of:
 * - scripts/backup-cleanup-lambda.ts
 * - scripts/backup-compliance-report-lambda.ts
 *
 * Verifies that handlers can run deterministically in-process with realistic
 * mock AWS environments without real AWS credentials or external cloud infrastructure.
 *
 * Run with:
 *   npx tsx --test scripts/__tests__/invoke-lambda-local.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeLambdaLocal,
  createMockLambdaContext,
  createMockLambdaEvent,
  getDefaultMockAwsData,
} from '../lib/invoke-lambda-local';

describe('invoke-lambda-local helper', () => {
  describe('mock context & event generation', () => {
    it('generates a valid AWS Lambda context with expected helper methods', () => {
      const ctx = createMockLambdaContext('test-function');
      assert.equal(ctx.functionName, 'test-function');
      assert.equal(ctx.functionVersion, '$LATEST');
      assert.match(ctx.invokedFunctionArn, /arn:aws:lambda:/);
      assert.match(ctx.awsRequestId, /^mock-req-/);
      assert.equal(typeof ctx.getRemainingTimeInMillis, 'function');
      assert.ok(ctx.getRemainingTimeInMillis() > 0);
    });

    it('generates a valid CloudWatch scheduled event shape', () => {
      const evt = createMockLambdaEvent('cleanup');
      assert.equal(evt.source, 'aws.events');
      assert.equal(evt['detail-type'], 'Scheduled Event');
      assert.ok(Array.isArray(evt.resources));
      assert.equal(evt.detail?.dryRun, true);
    });
  });

  describe('backup-cleanup-lambda local execution', () => {
    it('identifies and deletes expired snapshots according to retention policies', async () => {
      const result = await invokeLambdaLocal({
        target: 'cleanup',
        dryRun: true,
      });

      assert.equal(result.target, 'cleanup');
      assert.equal(result.dryRun, true);
      assert.ok(result.durationMs >= 0);

      // Handler output checks
      assert.equal(typeof result.output.deletedCount, 'number');
      assert.equal(result.output.deletedCount, 2);
      assert.deepEqual(result.output.errors, []);

      // Mock state inspection
      assert.ok(result.mockState);
      assert.equal(result.mockState.deletedSnapshots.length, 2);
      assert.ok(result.mockState.deletedSnapshots.includes('tariffshield-prod-2024-01-01'));
      assert.ok(result.mockState.deletedSnapshots.includes('tariffshield-weekly-2024-01-01'));
      assert.equal(result.mockState.auditRecordsCount, 2);
    });

    it('handles scenario where no snapshots are expired', async () => {
      const now = Date.now();
      const customData = {
        snapshots: [
          {
            DBSnapshotIdentifier: 'tariffshield-prod-2026-10-18',
            CreateTime: new Date(now - 1000 * 60 * 60), // 1 hour old
            StorageEncrypted: true,
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/test',
          },
        ],
        deletedSnapshots: [],
        putAuditItems: [],
      };

      const result = await invokeLambdaLocal({
        target: 'cleanup',
        dryRun: true,
        customMockData: customData,
      });

      assert.equal(result.output.deletedCount, 0);
      assert.deepEqual(result.output.errors, []);
      assert.equal(result.mockState?.deletedSnapshots.length, 0);
    });

    it('skips unencrypted snapshots to prevent data loss or policy violations', async () => {
      const now = Date.now();
      const customData = {
        snapshots: [
          {
            DBSnapshotIdentifier: 'tariffshield-prod-2023-01-01',
            CreateTime: new Date(now - 1000 * 24 * 60 * 60 * 1000), // very old
            StorageEncrypted: false, // unencrypted
            KmsKeyId: 'none',
          },
        ],
        deletedSnapshots: [],
        putAuditItems: [],
      };

      const result = await invokeLambdaLocal({
        target: 'cleanup',
        dryRun: true,
        customMockData: customData,
      });

      assert.equal(result.output.deletedCount, 0);
      assert.equal(result.mockState?.deletedSnapshots.length, 0);
    });
  });

  describe('backup-compliance-report-lambda local execution', () => {
    it('aggregates evidence across RDS, S3, and DynamoDB into compliance report', async () => {
      const result = await invokeLambdaLocal({
        target: 'compliance-report',
        dryRun: true,
      });

      assert.equal(result.target, 'compliance-report');
      assert.equal(result.dryRun, true);
      assert.equal(result.output.status, 'success');
      assert.match(result.output.reportKey, /^backup-compliance\/report-\d{4}-\d{2}-\d{2}\.json$/);

      // Verify S3 report upload was captured in mock state
      assert.ok(result.mockState);
      assert.equal(result.mockState.uploadedObjectsCount, 1);
    });
  });

  describe('error handling and validation', () => {
    it('rejects unrecognized target gracefully', async () => {
      await assert.rejects(
        async () => {
          await invokeLambdaLocal({ target: 'non-existent' as any });
        },
        {
          name: 'Error',
          message: /Unknown target: non-existent/,
        }
      );
    });
  });
});
