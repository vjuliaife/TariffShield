import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1038: Dual Sign-Off Approval Workflow for Large Withdrawals ───────────
  await client.query(`
    ALTER TABLE importers
      ADD COLUMN IF NOT EXISTS dual_approval_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS dual_approval_threshold_stroops NUMERIC(20, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS second_approver_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS second_approver_email TEXT;

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_stroops NUMERIC(20, 0) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      second_approver_id UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
      rejection_reason TEXT,
      job_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_importer_status
      ON withdrawal_requests(importer_id, status);
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_created_at
      ON withdrawal_requests(created_at DESC);
  `);

  // ── #1040: Bulk HS Code Mapping Table for Product Catalogs ─────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS importer_sku_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      sku TEXT NOT NULL,
      hts_code TEXT NOT NULL,
      description TEXT,
      duty_rate NUMERIC(10, 4),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_importer_sku_version UNIQUE (importer_id, version, sku)
    );

    CREATE INDEX IF NOT EXISTS idx_sku_mappings_importer_active
      ON importer_sku_mappings(importer_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_importer_sku
      ON importer_sku_mappings(importer_id, sku);
  `);

  // ── #1041: Document Expiration Tracking Columns ───────────────────────────
  await client.query(`
    ALTER TABLE kyc_documents
      ADD COLUMN IF NOT EXISTS expiration_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS document_name TEXT;

    ALTER TABLE surety_state_licenses
      ADD COLUMN IF NOT EXISTS expiration_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS renewal_url TEXT;

    CREATE INDEX IF NOT EXISTS idx_kyc_docs_expiry
      ON kyc_documents(expiration_date)
      WHERE expiration_date IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_surety_licenses_expiry
      ON surety_state_licenses(expiration_date)
      WHERE expiration_date IS NOT NULL;
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS importer_sku_mappings CASCADE;
    DROP TABLE IF EXISTS withdrawal_requests CASCADE;
    ALTER TABLE importers
      DROP COLUMN IF EXISTS dual_approval_enabled,
      DROP COLUMN IF EXISTS dual_approval_threshold_stroops,
      DROP COLUMN IF EXISTS second_approver_id,
      DROP COLUMN IF EXISTS second_approver_email;
    ALTER TABLE kyc_documents
      DROP COLUMN IF EXISTS expiration_date,
      DROP COLUMN IF EXISTS document_name;
    ALTER TABLE surety_state_licenses
      DROP COLUMN IF EXISTS expiration_date,
      DROP COLUMN IF EXISTS renewal_url;
  `);
};
