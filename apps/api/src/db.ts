import { Pool } from "pg";
import { env } from "./env.js";

const url = new URL(env.DATABASE_URL);
const sslRequired = url.searchParams.get("sslmode") === "require";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
});

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'importer' CHECK (role IN ('importer', 'surety_admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS importers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      legal_name TEXT NOT NULL,
      ein TEXT,
      bond_id BIGINT UNIQUE NOT NULL,
      stellar_address TEXT NOT NULL,
      stellar_secret_encrypted TEXT,
      collateral_balance NUMERIC(20, 0) NOT NULL DEFAULT 0,
      registered_on_chain_tx TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tariff_uploads (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      filename TEXT,
      annual_duty_total NUMERIC(20, 2) NOT NULL,
      computed_required_collateral NUMERIC(20, 0) NOT NULL,
      applied_tx TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contract_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount NUMERIC(20, 0),
      tx_hash TEXT NOT NULL,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_contract_events_importer ON contract_events(importer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS indexer_state (
      id TEXT PRIMARY KEY,
      last_processed_ledger INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("[migrate] schema ready");
}

export async function getLastProcessedLedger(): Promise<number | null> {
  const result = await pool.query(
    "SELECT last_processed_ledger FROM indexer_state WHERE id = $1",
    ["default"]
  );
  if (!result.rowCount || result.rowCount === 0) {
    return null;
  }
  return result.rows[0].last_processed_ledger;
}

export async function updateLastProcessedLedger(ledger: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_state (id, last_processed_ledger, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE
     SET last_processed_ledger = EXCLUDED.last_processed_ledger,
         updated_at = now()`,
    ["default", ledger]
  );
}

/**
 * Pings the database to check if it's alive.
 */
export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Returns all bonds that have been registered on-chain.
 */
export async function getActiveBonds(): Promise<{ bondId: string; dbBalance: string }[]> {
  const result = await pool.query(
    "SELECT bond_id, collateral_balance FROM importers WHERE registered_on_chain_tx IS NOT NULL"
  );
  return result.rows.map((row) => ({
    bondId: row.bond_id,
    dbBalance: row.collateral_balance,
  }));
}
