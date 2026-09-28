import type { PoolClient } from 'pg';

// ── #993: Recurring Collateral Deposit Scheduling ───────────────────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS deposit_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
      amount_stroops NUMERIC(20, 0) NOT NULL,
      bucket TEXT NOT NULL DEFAULT 'collateral' CHECK (bucket IN ('collateral', 'reserve')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
      next_run_at TIMESTAMPTZ NOT NULL,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_schedules_importer
      ON deposit_schedules(importer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposit_schedules_due
      ON deposit_schedules(next_run_at) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS deposit_schedule_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id UUID NOT NULL REFERENCES deposit_schedules(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      amount_stroops NUMERIC(20, 0) NOT NULL,
      bucket TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
      job_id TEXT,
      error_message TEXT,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_schedule_executions_schedule
      ON deposit_schedule_executions(schedule_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposit_schedule_executions_importer
      ON deposit_schedule_executions(importer_id, executed_at DESC);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS deposit_schedule_executions CASCADE;
    DROP TABLE IF EXISTS deposit_schedules CASCADE;
  `);
};
