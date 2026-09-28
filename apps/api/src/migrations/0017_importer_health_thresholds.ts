import type { PoolClient } from 'pg';

// ── #1017: Configurable Alert Thresholds for Collateral Health Score ──────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS importer_health_thresholds (
      importer_id UUID PRIMARY KEY REFERENCES importers(id) ON DELETE CASCADE,
      warning_threshold INT NOT NULL DEFAULT 60 CHECK (warning_threshold BETWEEN 1 AND 100),
      critical_threshold INT NOT NULL DEFAULT 40 CHECK (critical_threshold BETWEEN 0 AND 99),
      last_notified_state VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT valid_threshold_bounds CHECK (critical_threshold < warning_threshold)
    );
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS importer_health_thresholds;
  `);
};
