-- Migration #009: Compliance Escalation Rules and Surety Marketplace
-- Issue #1034: Automated escalation rules for unresolved compliance flags
-- Issue #1036: Surety partner rate comparison marketplace

-- Compliance escalation rules table
CREATE TABLE IF NOT EXISTS compliance_escalation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  age_threshold_hours INTEGER NOT NULL CHECK (age_threshold_hours > 0),
  escalation_target_role TEXT NOT NULL CHECK (escalation_target_role IN ('senior_admin', 'specific_user')),
  escalation_target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_escalation_rules_surety 
  ON compliance_escalation_rules(surety_id, is_active);

-- Compliance escalation history table
CREATE TABLE IF NOT EXISTS compliance_escalation_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_id UUID NOT NULL REFERENCES compliance_flags(id) ON DELETE CASCADE,
  escalation_rule_id UUID NOT NULL REFERENCES compliance_escalation_rules(id) ON DELETE SET NULL,
  previous_assignee UUID REFERENCES users(id) ON DELETE SET NULL,
  new_assignee UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_escalation_history_flag
  ON compliance_escalation_history(flag_id, escalated_at DESC);

-- Add missing columns to compliance_flags if not already present
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS case_status TEXT NOT NULL DEFAULT 'new'
  CHECK (case_status IN ('new', 'investigating', 'escalated', 'resolved'));
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('low', 'medium', 'high', 'critical'));

-- Case notes for compliance flags
CREATE TABLE IF NOT EXISTS compliance_case_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_id UUID NOT NULL REFERENCES compliance_flags(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_notes_flag
  ON compliance_case_notes(flag_id, created_at DESC);

-- Surety marketplace partners table
CREATE TABLE IF NOT EXISTS surety_marketplace_partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  surety_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  naic_number TEXT,
  am_best_rating TEXT,
  collateral_ratio NUMERIC(5, 2) NOT NULL CHECK (collateral_ratio > 0),
  coverage_types TEXT[] NOT NULL DEFAULT ARRAY['continuous'],
  base_premium_rate NUMERIC(5, 4) NOT NULL CHECK (base_premium_rate > 0),
  description TEXT,
  min_bond_amount NUMERIC(20, 2) NOT NULL,
  max_bond_amount NUMERIC(20, 2) NOT NULL,
  states_licensed_count INTEGER NOT NULL DEFAULT 0,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  website_url TEXT,
  stellar_contract_address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_surety_marketplace_partners_active
  ON surety_marketplace_partners(is_active, is_published, collateral_ratio);

CREATE INDEX IF NOT EXISTS idx_surety_marketplace_partners_rating
  ON surety_marketplace_partners(am_best_rating DESC NULLS LAST) WHERE is_published = TRUE;

-- Add notifications table if not exists (referenced by escalation job)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- Add audit_log table if not exists (referenced by compliance operations)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log(actor_user_id, created_at DESC);
