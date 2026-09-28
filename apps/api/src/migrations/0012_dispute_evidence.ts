import type { PoolClient } from 'pg';

// ── #992: Allow Evidence Attachments on raise_dispute Submissions ────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dispute_id UUID NOT NULL REFERENCES collateral_disputes(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      file_name TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      s3_key_encrypted TEXT,
      virus_scan_status TEXT DEFAULT 'clean',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute
      ON dispute_evidence(dispute_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_importer
      ON dispute_evidence(importer_id, created_at DESC);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS dispute_evidence CASCADE;
  `);
};
