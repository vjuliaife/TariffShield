-- Migration 001: oracle_price_feed audit table and listener_state checkpoint
-- Up

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Durable audit trail for every set_required_collateral contract event.
CREATE TABLE IF NOT EXISTS oracle_price_feed (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  importer_id        UUID          REFERENCES importers(id) ON DELETE SET NULL,
  -- Stellar address used as a secondary key when importer_id is not yet resolved.
  importer_address   TEXT          NOT NULL,
  required_collateral  NUMERIC(20,7) NOT NULL,
  previous_collateral  NUMERIC(20,7) NOT NULL DEFAULT 0,
  pct_change           NUMERIC(7,4)  NOT NULL DEFAULT 0,
  tx_hash              VARCHAR(64)   NOT NULL,
  ledger_sequence      INTEGER       NOT NULL,
  set_by               VARCHAR(64)   NOT NULL DEFAULT '',
  emergency_override   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_price_feed_importer
  ON oracle_price_feed(importer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_price_feed_ledger
  ON oracle_price_feed(ledger_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_price_feed_tx_importer
  ON oracle_price_feed(tx_hash, importer_address);

-- Checkpoint table so the listener can resume from where it left off after a restart.
CREATE TABLE IF NOT EXISTS listener_state (
  id                    TEXT PRIMARY KEY,
  last_ledger_sequence  INTEGER      NOT NULL,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
