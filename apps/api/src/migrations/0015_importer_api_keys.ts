import type { PoolClient } from 'pg';

// ── #995: Self-Service API Key Management for SDK Integrations ───────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID REFERENCES importers(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      label TEXT,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      rate_limit_per_min INTEGER DEFAULT 60,
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS importer_id UUID REFERENCES importers(id) ON DELETE CASCADE;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER DEFAULT 60;

    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_importer_id ON api_keys(importer_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    ALTER TABLE api_keys DROP COLUMN IF EXISTS importer_id;
  `);
};
