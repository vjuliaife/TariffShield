/**
 * Dry-run smoke tests for scripts/backup-restore-drill.sh.
 *
 * Runs the drill with --dry-run (and LOCAL_DRY_RUN=1) in a temp directory. The
 * script mocks its own aws/psql calls in dry-run mode, so these tests exercise
 * the full control flow and the DRILL_REPORT_FILE shape without credentials or
 * a real RDS instance. Skipped on Windows, where the script cannot run.
 *
 * Run with:  npx tsx --test scripts/__tests__/backup-restore-drill.test.ts
 * (or, repo-wide: npm run test:scripts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, '../backup-restore-drill.sh');
const IS_WINDOWS = process.platform === 'win32';

interface DrillValidation {
  connection: string;
  schema_completeness: string;
  table_count: number;
  user_count: number;
  importer_count: number;
  contract_events_count: number;
  ein_format_validation: string;
}

interface DrillReport {
  drill_timestamp: string;
  mode: string;
  status: string;
  source_snapshot: string;
  temp_instance: string;
  temp_endpoint: string;
  validation: DrillValidation;
  notes: string;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-drill-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runScript(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd,
    env: { ...process.env, LOCAL_DRY_RUN: '', ...extraEnv },
    encoding: 'utf8',
  });
}

describe('backup-restore-drill.sh --dry-run', { skip: IS_WINDOWS }, () => {
  it('produces a PASSED report with canned validation data and a stable shape', () => {
    withTempDir((dir) => {
      const reportPath = path.join(dir, 'drill-report.json');
      const result = runScript(['--dry-run'], dir, { DRILL_REPORT_FILE: reportPath });

      assert.equal(
        result.status,
        0,
        `script exited ${result.status}\n${result.stdout}\n${result.stderr}`
      );
      assert.ok(fs.existsSync(reportPath), 'DRILL_REPORT_FILE was not written');

      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as DrillReport;

      // The report shape is what downstream automation consumes — pin it so
      // report-shape edits are caught locally before reaching AWS.
      assert.deepEqual(Object.keys(report).sort(), [
        'drill_timestamp',
        'mode',
        'notes',
        'source_snapshot',
        'status',
        'temp_endpoint',
        'temp_instance',
        'validation',
      ]);
      assert.deepEqual(Object.keys(report.validation).sort(), [
        'connection',
        'contract_events_count',
        'ein_format_validation',
        'importer_count',
        'schema_completeness',
        'table_count',
        'user_count',
      ]);

      assert.equal(report.mode, 'dry-run');
      assert.equal(report.status, 'PASSED');
      assert.equal(report.validation.connection, 'OK');
      assert.equal(report.validation.schema_completeness, 'OK');
      assert.equal(report.validation.table_count, 8);
      assert.equal(report.validation.ein_format_validation, 'OK');
      assert.equal(typeof report.validation.user_count, 'number');
      assert.equal(typeof report.validation.importer_count, 'number');
      assert.equal(typeof report.validation.contract_events_count, 'number');
      assert.match(report.notes, /dry run/i);
    });
  });

  it('skips instance creation, deletion, and AWS writes', () => {
    withTempDir((dir) => {
      const reportPath = path.join(dir, 'drill-report.json');
      const result = runScript(['--dry-run'], dir, { DRILL_REPORT_FILE: reportPath });
      const output = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 0);
      assert.match(output, /Skipping snapshot restore/);
      assert.match(output, /Skipping deletion/);
      assert.match(output, /Skipping upload/);
      assert.match(output, /Skipping DynamoDB/);
    });
  });

  it('is also enabled with LOCAL_DRY_RUN=1', () => {
    withTempDir((dir) => {
      const reportPath = path.join(dir, 'drill-report.json');
      const result = runScript([], dir, { LOCAL_DRY_RUN: '1', DRILL_REPORT_FILE: reportPath });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as DrillReport;
      assert.equal(report.mode, 'dry-run');
      assert.equal(report.status, 'PASSED');
    });
  });

  it('rejects unknown arguments without writing a report', () => {
    withTempDir((dir) => {
      const reportPath = path.join(dir, 'drill-report.json');
      const result = runScript(['--bogus'], dir, { DRILL_REPORT_FILE: reportPath });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /Unknown argument/);
      assert.ok(!fs.existsSync(reportPath), 'no report should be written for invalid args');
    });
  });
});
