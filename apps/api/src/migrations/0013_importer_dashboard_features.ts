import type { PoolClient } from 'pg';

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users ADD COLUMN referral_code TEXT;
    UPDATE users SET referral_code = upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
    CREATE UNIQUE INDEX users_referral_code_unique ON users(referral_code);
    ALTER TABLE users ALTER COLUMN referral_code SET NOT NULL;
    ALTER TABLE users ALTER COLUMN referral_code
      SET DEFAULT upper(left(replace(gen_random_uuid()::text, '-', ''), 12));

    CREATE TABLE importer_referrals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      referral_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      converted_at TIMESTAMPTZ,
      CHECK (referrer_user_id <> referred_user_id)
    );
    CREATE INDEX importer_referrals_referrer_idx
      ON importer_referrals(referrer_user_id, created_at DESC);

    CREATE TABLE importer_dashboard_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      widget_order TEXT[] NOT NULL DEFAULT ARRAY['health', 'balance', 'yield', 'activity'],
      hidden_widgets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      onboarding_dismissed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE importer_co_sureties (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      participant_name TEXT NOT NULL,
      participant_reference TEXT NOT NULL,
      participation_bps INTEGER NOT NULL CHECK (participation_bps > 0 AND participation_bps <= 10000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(importer_id, participant_reference)
    );
    CREATE INDEX importer_co_sureties_importer_idx ON importer_co_sureties(importer_id);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS importer_co_sureties;
    DROP TABLE IF EXISTS importer_dashboard_preferences;
    DROP TABLE IF EXISTS importer_referrals;
    DROP INDEX IF EXISTS users_referral_code_unique;
    ALTER TABLE users DROP COLUMN IF EXISTS referral_code;
  `);
}
