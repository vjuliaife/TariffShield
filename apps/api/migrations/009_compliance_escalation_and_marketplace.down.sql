-- Rollback migration #009: Compliance Escalation Rules and Surety Marketplace

DROP INDEX IF EXISTS idx_surety_marketplace_partners_rating;
DROP INDEX IF EXISTS idx_surety_marketplace_partners_active;
DROP TABLE IF EXISTS surety_marketplace_partners;

DROP INDEX IF EXISTS idx_compliance_case_notes_flag;
DROP TABLE IF EXISTS compliance_case_notes;

DROP INDEX IF EXISTS idx_compliance_escalation_history_flag;
DROP TABLE IF EXISTS compliance_escalation_history;

DROP INDEX IF EXISTS idx_compliance_escalation_rules_surety;
DROP TABLE IF EXISTS compliance_escalation_rules;

-- Note: We don't drop compliance_flags columns, notifications, or audit_log
-- as they may be used by other features
