// 0006_stakeholder_subscriptions_annotations_sla.ts
// Adds tables for:
// - Issue #1047: Stakeholder notification subscriptions for contract upgrade proposals
// - Issue #1046: Admin/Importer annotation notes on bond timeline events
// - Issue #1042: Configurable business hours and SLA tracking for admin response times
//
// Migration: 0006_stakeholder_subscriptions_annotations_sla
// Date: 2026-08-28

import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1047: Stakeholder notification subscriptions ──────────────────────────

  await client.query(`
    CREATE TABLE IF NOT EXISTS upgrade_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      surety_id UUID NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, surety_id)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_upgrade_subscriptions_user_surety
    ON upgrade_subscriptions (user_id, surety_id, is_active)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_upgrade_subscriptions_surety_active
    ON upgrade_subscriptions (surety_id, is_active)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS upgrade_notification_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      proposal_id BIGINT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('proposed', 'approved', 'cancelled')),
      proposer TEXT NOT NULL,
      approval_count INTEGER NOT NULL DEFAULT 0,
      wasm_hash TEXT,
      notification_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_upgrade_notification_history_proposal
    ON upgrade_notification_history (proposal_id, created_at DESC)
  `);

  // ── #1046: Bond timeline event annotations ────────────────────────────────

  await client.query(`
    CREATE TABLE IF NOT EXISTS bond_timeline_annotations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      surety_id UUID NOT NULL,
      author_id UUID NOT NULL REFERENCES users(id),
      author_role TEXT NOT NULL CHECK (author_role IN ('importer', 'surety_admin')),
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bond_timeline_annotations_event
    ON bond_timeline_annotations (event_id, created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bond_timeline_annotations_importer
    ON bond_timeline_annotations (importer_id, surety_id, created_at DESC)
  `);

  // ── #1042: Configurable business hours and SLA tracking ───────────────────

  await client.query(`
    CREATE TABLE IF NOT EXISTS business_hours_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      surety_id UUID NOT NULL UNIQUE,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      monday_start TIME,
      monday_end TIME,
      tuesday_start TIME,
      tuesday_end TIME,
      wednesday_start TIME,
      wednesday_end TIME,
      thursday_start TIME,
      thursday_end TIME,
      friday_start TIME,
      friday_end TIME,
      saturday_start TIME,
      saturday_end TIME,
      sunday_start TIME,
      sunday_end TIME,
      holidays JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sla_targets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      surety_id UUID NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('compliance_flag', 'dispute', 'ticket')),
      target_hours NUMERIC NOT NULL DEFAULT 24,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(surety_id, item_type)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_targets_surety_type
    ON sla_targets (surety_id, item_type)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sla_tracking (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      surety_id UUID NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('compliance_flag', 'dispute', 'ticket')),
      item_id UUID NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deadline TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      is_breached BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_tracking_surety_type_status
    ON sla_tracking (surety_id, item_type, is_breached, resolved_at)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_tracking_item
    ON sla_tracking (item_id, item_type)
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`DROP TABLE IF EXISTS sla_tracking`);
  await client.query(`DROP TABLE IF EXISTS sla_targets`);
  await client.query(`DROP TABLE IF EXISTS business_hours_config`);
  await client.query(`DROP TABLE IF EXISTS bond_timeline_annotations`);
  await client.query(`DROP TABLE IF EXISTS upgrade_notification_history`);
  await client.query(`DROP TABLE IF EXISTS upgrade_subscriptions`);
};
