import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1006: per-file virus-scan status for KYC documents ───────────────────
  await client.query(`
    ALTER TABLE kyc_documents
      ADD COLUMN IF NOT EXISTS virus_scan_status TEXT NOT NULL DEFAULT 'pending';

    DO $$ BEGIN
      ALTER TABLE kyc_documents
        ADD CONSTRAINT kyc_documents_virus_scan_status_check
        CHECK (virus_scan_status IN ('pending', 'clean', 'infected'));
    EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

    -- Documents uploaded before the scan integration existed are grandfathered
    -- as clean; every insert from this migration on sets the status explicitly.
    UPDATE kyc_documents SET virus_scan_status = 'clean' WHERE virus_scan_status = 'pending';
  `);

  // ── #1007: importer credit-line pre-approvals ─────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS credit_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
      amount NUMERIC(20, 0) NOT NULL CHECK (amount > 0),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked')),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
      notified_expiring BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT credit_lines_expiry_after_grant CHECK (expires_at > granted_at)
    );

    CREATE INDEX IF NOT EXISTS idx_credit_lines_importer_status
      ON credit_lines(importer_id, status);

    CREATE INDEX IF NOT EXISTS idx_credit_lines_expiry
      ON credit_lines(status, expires_at)
      WHERE status = 'active';
  `);

  // ── #1009: configurable multi-step approval chains ────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS approval_chains (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL DEFAULT 'importer_review'
        CHECK (scope IN ('importer_review')),
      steps JSONB NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_approval_chain_name_version UNIQUE (name, version)
    );

    CREATE TABLE IF NOT EXISTS approval_chain_instances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chain_id UUID NOT NULL REFERENCES approval_chains(id) ON DELETE RESTRICT,
      chain_version INTEGER NOT NULL,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      steps JSONB NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'approved', 'rejected')),
      started_by UUID REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_approval_chain_instances_importer
      ON approval_chain_instances(importer_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_chain_instance_open
      ON approval_chain_instances(importer_id)
      WHERE status = 'in_progress';

    CREATE TABLE IF NOT EXISTS approval_chain_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id UUID NOT NULL REFERENCES approval_chain_instances(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      required_role TEXT NOT NULL,
      step_name TEXT NOT NULL,
      approver_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      note TEXT,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_approval_chain_decision_per_step UNIQUE (instance_id, step_number)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_chain_decisions_instance
      ON approval_chain_decisions(instance_id, step_number);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS approval_chain_decisions CASCADE;
    DROP TABLE IF EXISTS approval_chain_instances CASCADE;
    DROP TABLE IF EXISTS approval_chains CASCADE;
    DROP TABLE IF EXISTS credit_lines CASCADE;
    ALTER TABLE kyc_documents
      DROP COLUMN IF EXISTS virus_scan_status;
  `);
};
