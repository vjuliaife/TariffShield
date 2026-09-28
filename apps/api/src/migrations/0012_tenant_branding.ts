import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #998: white-label branding per surety/partner tenant ──────────────────
  // One row per surety_admin tenant. Every column except the slug is
  // nullable: a NULL falls back to the default TariffShield value at read
  // time, so a partner can override just the colour or just the logo.
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_branding (
      surety_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
      brand_name TEXT,
      logo_data_url TEXT,
      primary_color TEXT CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`DROP TABLE IF EXISTS tenant_branding CASCADE;`);
};
