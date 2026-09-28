import type { PoolClient } from 'pg';

// ── #1015: Importer Sub-Account / Team Member Invites with Role-Based Permissions ─────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE team_member_role AS ENUM ('admin', 'finance', 'viewer');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      CREATE TYPE team_member_status AS ENUM ('pending', 'active', 'revoked');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    CREATE TABLE IF NOT EXISTS importer_team_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      email VARCHAR(255) NOT NULL,
      role team_member_role NOT NULL DEFAULT 'viewer',
      status team_member_status NOT NULL DEFAULT 'pending',
      invite_token_hash VARCHAR(64) UNIQUE,
      invited_by UUID NOT NULL REFERENCES users(id),
      invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT unique_importer_member_email UNIQUE (importer_id, email)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_importer_status ON importer_team_members(importer_id, status);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON importer_team_members(user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_team_members_invite_hash ON importer_team_members(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS importer_team_members;
    DROP TYPE IF EXISTS team_member_status;
    DROP TYPE IF EXISTS team_member_role;
  `);
};
