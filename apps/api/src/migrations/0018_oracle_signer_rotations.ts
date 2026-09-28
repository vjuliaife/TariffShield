import type { PoolClient } from 'pg';

// ── #1018: Bulk Oracle Signer Rotation Workflow for Surety Admins ────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE rotation_status AS ENUM ('proposed', 'pending_signatures', 'executed', 'cancelled');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    CREATE TABLE IF NOT EXISTS oracle_signer_rotations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      proposed_by UUID NOT NULL REFERENCES users(id),
      new_signers JSONB NOT NULL,
      threshold INT NOT NULL DEFAULT 2,
      approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
      status rotation_status NOT NULL DEFAULT 'proposed',
      tx_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      executed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_signer_rotations_status ON oracle_signer_rotations(status);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS oracle_signer_rotations;
    DROP TYPE IF EXISTS rotation_status;
  `);
};
