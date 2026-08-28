// 0008_dev_usage_and_onboarding_drip.ts
// Adds tables for:
// - Issue #1043: Developer dashboard for API key usage and rate-limit status
// - Issue #1044: Automated onboarding email drip campaign for new signups
//
// Migration: 0008_dev_usage_and_onboarding_drip
// Date: 2026-08-28

import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1043: per-API-key request metering ──────────────────────────────────
  //
  // One row per (key, endpoint category, minute). Minute granularity keeps the
  // rate-limit indicator meaningful while 30-day retention (see
  // jobs/prune-api-key-usage.ts) bounds the row count to ~43k per key/category.
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_key_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      endpoint_category TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (api_key_id, endpoint_category, window_start)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_window
    ON api_key_usage (api_key_id, window_start DESC)
  `);

  // Retention sweep predicate.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_key_usage_window
    ON api_key_usage (window_start)
  `);

  // Optional per-key ceiling. NULL = no configured limit (the dashboard then
  // only reports volume, no quota indicator).
  await client.query(`
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER
  `);

  // ── #1044: onboarding drip campaign ─────────────────────────────────────

  await client.query(`
    CREATE TABLE IF NOT EXISTS onboarding_drip_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      step_key TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      delay_hours INTEGER NOT NULL DEFAULT 0,
      -- action the step nudges toward; when the importer has already done it
      -- the step is skipped instead of sent.
      completion_check TEXT NOT NULL CHECK (completion_check IN ('kyc', 'deposit', 'tariff', 'none')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS onboarding_drip_enrollments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_onboarding_drip_enrollments_open
    ON onboarding_drip_enrollments (enrolled_at)
    WHERE completed_at IS NULL AND unsubscribed_at IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS onboarding_drip_sends (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      enrollment_id UUID NOT NULL REFERENCES onboarding_drip_enrollments(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'skipped')),
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (enrollment_id, step_key)
    )
  `);

  // Default sequence — admin-editable afterwards via PUT /onboarding/drip/steps/:stepKey.
  await client.query(`
    INSERT INTO onboarding_drip_steps (step_key, position, subject, body, delay_hours, completion_check)
    VALUES
      ('complete_kyc', 1, 'Finish verifying your business',
       'Welcome to TariffShield! Your next step is to complete KYC so your bond can go active. It takes about 5 minutes.',
       1, 'kyc'),
      ('first_deposit', 2, 'Fund your bond collateral',
       'Your account is ready for its first deposit. Add collateral to activate coverage for your import bond.',
       72, 'deposit'),
      ('upload_tariff', 3, 'Upload your tariff CSV',
       'Upload your annual duty estimate so TariffShield can size your required collateral automatically.',
       168, 'tariff')
    ON CONFLICT (step_key) DO NOTHING
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`DROP TABLE IF EXISTS onboarding_drip_sends`);
  await client.query(`DROP TABLE IF EXISTS onboarding_drip_enrollments`);
  await client.query(`DROP TABLE IF EXISTS onboarding_drip_steps`);
  await client.query(`DROP TABLE IF EXISTS api_key_usage`);
  await client.query(`ALTER TABLE api_keys DROP COLUMN IF EXISTS rate_limit_per_min`);
};
