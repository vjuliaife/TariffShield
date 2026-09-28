import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #991: in-app support tickets between importers and surety_admin ───────
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      opened_by_user_id UUID NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_importer ON support_tickets(importer_id, created_at DESC);
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_replies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author_user_id UUID NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON support_ticket_replies(ticket_id, created_at ASC);
  `);

  // ── #990: per-event, per-channel notification preferences ─────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'in_app')),
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, event_type, channel)
    );
  `);

  // ── #988: broker delegated-access role ─────────────────────────────────────
  // users.role is a plain TEXT column (see 0001_initial_schema.ts) with no
  // CHECK constraint restricting it to 'importer'/'surety_admin', so adding
  // 'broker' as a value needs no column migration -- only the new grants table.
  await client.query(`
    CREATE TABLE IF NOT EXISTS broker_importer_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      broker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      granted_by_user_id UUID NOT NULL REFERENCES users(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      UNIQUE (broker_user_id, importer_id)
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broker_grants_broker ON broker_importer_grants(broker_user_id)
      WHERE revoked_at IS NULL;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broker_grants_importer ON broker_importer_grants(importer_id)
      WHERE revoked_at IS NULL;
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`DROP TABLE IF EXISTS broker_importer_grants CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS notification_preferences CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS support_ticket_replies CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS support_tickets CASCADE;`);
};
