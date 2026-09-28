import type { PoolClient } from 'pg';

// ── #994: Future-Dated Staged Withdrawal Scheduling for Collateral ───────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS scheduled_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_stroops NUMERIC(20, 0) NOT NULL,
      target_date TIMESTAMPTZ NOT NULL,
      target_address TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'blocked', 'cancelled')),
      execution_result TEXT,
      executed_at TIMESTAMPTZ,
      job_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_withdrawals_importer
      ON scheduled_withdrawals(importer_id, target_date ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_withdrawals_due
      ON scheduled_withdrawals(target_date) WHERE status = 'pending';
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS scheduled_withdrawals CASCADE;
  `);
};
