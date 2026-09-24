import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1015: Importer sub-accounts / team member invites with RBAC ──────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS importer_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'finance', 'viewer')),
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(importer_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_importer_members_user ON importer_members(user_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_importer_members_importer ON importer_members(importer_id);

    CREATE TABLE IF NOT EXISTS importer_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'finance', 'viewer')),
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_by UUID NOT NULL REFERENCES users(id),
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_importer_invites_token ON importer_invites(token_hash) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_importer_invites_importer ON importer_invites(importer_id);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS importer_invites CASCADE;
    DROP TABLE IF EXISTS importer_members CASCADE;
  `);
};
