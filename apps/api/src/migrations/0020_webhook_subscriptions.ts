import type { PoolClient } from 'pg';

// ── #1023: Configurable Outbound Webhook Subscriptions for Importers ─────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      target_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_types TEXT[] NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_importer_active
    ON webhook_subscriptions (importer_id, is_active);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      status_code INTEGER,
      response_body TEXT,
      error_message TEXT,
      delivered_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'pending_retry')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_importer_created
    ON webhook_deliveries (importer_id, created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub_created
    ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhook_subscriptions;
  `);
};
