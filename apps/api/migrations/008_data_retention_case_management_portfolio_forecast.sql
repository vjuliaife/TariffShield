-- Migration 008: Data retention policies, case management queue, portfolio view, and tariff forecasting

-- #1031: Data retention policies per data category
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
  data_category TEXT NOT NULL CHECK (data_category IN ('documents', 'logs', 'events', 'tariff_uploads')),
  retention_days INTEGER NOT NULL CHECK (retention_days > 0),
  is_regulatory_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (importer_id, data_category)
);

CREATE INDEX IF NOT EXISTS idx_data_retention_policies_importer ON data_retention_policies(importer_id);

-- #1029: Case management queue for compliance flags
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id);
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS case_status TEXT DEFAULT 'new' CHECK (case_status IN ('new', 'investigating', 'escalated', 'resolved'));

-- Case notes table
CREATE TABLE IF NOT EXISTS compliance_case_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_id UUID NOT NULL REFERENCES compliance_flags(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_notes_flag ON compliance_case_notes(flag_id, created_at DESC);

-- Index for queue filtering
CREATE INDEX IF NOT EXISTS idx_compliance_flags_assignment ON compliance_flags(assigned_to, case_status, priority);
CREATE INDEX IF NOT EXISTS idx_compliance_flags_status ON compliance_flags(case_status, priority);