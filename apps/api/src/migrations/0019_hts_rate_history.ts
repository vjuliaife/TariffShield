import type { PoolClient } from 'pg';

// ── #1019: Historical Tariff Rate Trend Charting ─────────────────────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS hts_rate_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hts_code VARCHAR(14) NOT NULL,
      duty_rate NUMERIC(7,4) NOT NULL,
      effective_date DATE NOT NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'CBP_DATASET',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unique_hts_effective_date UNIQUE (hts_code, effective_date)
    );

    CREATE INDEX IF NOT EXISTS idx_hts_rate_history_lookup ON hts_rate_history(hts_code, effective_date ASC);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS hts_rate_history;
  `);
};
