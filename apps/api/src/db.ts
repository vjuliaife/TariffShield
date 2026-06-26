import { Pool, type QueryResult, type QueryResultRow } from "pg";
import pino from "pino";
import client from "prom-client";
import { env } from "./config/env.js";

const logger = pino({ name: "db" });

const url = new URL(env.DATABASE_URL);
const sslRequired = url.searchParams.get("sslmode") === "require";

const basePool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
});

// ── Prometheus metrics (#373) ─────────────────────────────────────────────────

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of PostgreSQL queries in seconds",
  labelNames: ["query_name"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const dbSlowQueriesTotal = new client.Counter({
  name: "db_slow_queries_total",
  help: "Total number of slow PostgreSQL queries",
  labelNames: ["threshold"],
});

// ── Query timing wrapper ──────────────────────────────────────────────────────

const SLOW_WARN_MS = 500;
const SLOW_ERROR_MS = 2000;
const SQL_TRUNCATE_LEN = 500;

function sanitizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, "?")
    .replace(/'[^']*'/g, "'?'")
    .slice(0, SQL_TRUNCATE_LEN);
}

function inferQueryName(sql: string): string {
  const s = sql.trim().toUpperCase();
  const m = s.match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+(?:INTO\s+|FROM\s+|TABLE\s+)?(\w+)?/);
  return m ? `${m[1]!.toLowerCase()}${m[2] ? `_${m[2]!.toLowerCase()}` : ""}` : "unknown";
}

async function timedQuery<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[],
  queryName?: string,
): Promise<QueryResult<R>> {
  const start = Date.now();
  const name = queryName ?? inferQueryName(sql);
  const endTimer = dbQueryDurationSeconds.startTimer({ query_name: name });

  try {
    const result = await basePool.query<R>(sql, values);
    const durationMs = Date.now() - start;
    endTimer();

    if (durationMs >= SLOW_ERROR_MS) {
      dbSlowQueriesTotal.inc({ threshold: "2000ms" });
      logger.error(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        "critically slow query",
      );
    } else if (durationMs >= SLOW_WARN_MS) {
      dbSlowQueriesTotal.inc({ threshold: "500ms" });
      logger.warn(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        "slow query",
      );
    }

    return result;
  } catch (err) {
    endTimer();
    throw err;
  }
}

export const pool = {
  query: timedQuery,
  end: () => basePool.end(),
};

// ── Schema migrations ─────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  await timedQuery(
    `
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'importer' CHECK (role IN ('importer', 'surety_admin')),
      locked_until TIMESTAMPTZ,
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

    CREATE TABLE IF NOT EXISTS oracle_alerts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      old_value NUMERIC(20, 0) NOT NULL,
      new_value NUMERIC(20, 0) NOT NULL,
      pct_change NUMERIC(5, 2) NOT NULL,
      tx_hash TEXT NOT NULL,
      alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      acknowledged_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS aml_screenings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wallet_address TEXT NOT NULL,
      screening_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      risk_score TEXT NOT NULL,
      provider_response JSONB,
      resolution_action TEXT
    );

    CREATE TABLE IF NOT EXISTS indexer_state (
      id TEXT PRIMARY KEY,
      last_processed_ledger INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS security_incidents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      incident_id TEXT UNIQUE NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL,
      affected_scope TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'contained', 'resolved')),
      resolution_timeline TIMESTAMPTZ,
      notification_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_security_incidents_severity ON security_incidents(severity, detected_at DESC);

    CREATE TABLE IF NOT EXISTS data_erasure_requests (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      request_id TEXT UNIQUE NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID REFERENCES importers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processing_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      sla_deadline TIMESTAMPTZ NOT NULL,
      affected_fields TEXT ARRAY,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_data_erasure_requests_status ON data_erasure_requests(status, sla_deadline);
    CREATE INDEX IF NOT EXISTS idx_data_erasure_requests_user ON data_erasure_requests(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bond_records (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      bond_id BIGINT NOT NULL,
      bond_type_code TEXT NOT NULL CHECK (bond_type_code IN ('01', '02', '03', '04')),
      principal_legal_name TEXT NOT NULL,
      principal_ein TEXT NOT NULL,
      surety_company_name TEXT NOT NULL,
      surety_fein TEXT NOT NULL,
      bond_amount NUMERIC(20, 0) NOT NULL,
      cbp_minimum_required NUMERIC(20, 0) NOT NULL,
      effective_date DATE NOT NULL,
      expiry_date DATE,
      template_version TEXT,
      cbp_regulation_revision_date DATE,
      requires_increase BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bond_records_importer ON bond_records(importer_id);
    CREATE INDEX IF NOT EXISTS idx_bond_records_requires_increase ON bond_records(requires_increase, updated_at DESC);

    CREATE TABLE IF NOT EXISTS authentication_attempts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_authentication_attempts_email_time ON authentication_attempts(email, attempted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_authentication_attempts_user_id ON authentication_attempts(user_id, attempted_at DESC);
  `,
    undefined,
    "migrate_schema",
  );
  console.log("[migrate] schema ready");
}

export async function getLastProcessedLedger(): Promise<number | null> {
  const result = await timedQuery<{ last_processed_ledger: number }>(
    "SELECT last_processed_ledger FROM indexer_state WHERE id = $1",
    ["default"],
    "select_indexer_state",
  );
  if (!result.rowCount || result.rowCount === 0) {
    return null;
  }
  return result.rows[0]!.last_processed_ledger;
}

export async function updateLastProcessedLedger(ledger: number): Promise<void> {
  await timedQuery(
    `INSERT INTO indexer_state (id, last_processed_ledger, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE
     SET last_processed_ledger = EXCLUDED.last_processed_ledger,
         updated_at = now()`,
    ["default", ledger],
    "upsert_indexer_state",
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

export async function recordAuthenticationAttempt(
  email: string,
  success: boolean,
  userId?: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  await timedQuery(
    `INSERT INTO authentication_attempts (email, success, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, success, userId ?? null, ipAddress ?? null, userAgent ?? null],
    "insert_auth_attempt",
  );
}

export async function getFailedAuthAttempts(email: string, withinMinutes: number = 30): Promise<number> {
  const result = await timedQuery<{ count: string }>(
    `SELECT COUNT(*) as count FROM authentication_attempts
     WHERE email = $1 AND success = FALSE
     AND attempted_at > now() - INTERVAL '${withinMinutes} minutes'`,
    [email],
    "count_failed_auth_attempts",
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function lockAccountTemporarily(userId: string, durationMinutes: number = 30): Promise<void> {
  await timedQuery(
    `UPDATE users SET locked_until = now() + INTERVAL '${durationMinutes} minutes'
     WHERE id = $1`,
    [userId],
    "lock_account",
  );
}

export async function recordSecurityIncident(
  severity: "P0" | "P1" | "P2" | "P3",
  description: string,
  affectedScope?: string,
): Promise<string> {
  const incidentId = `INC-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO security_incidents (incident_id, severity, description, affected_scope)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [incidentId, severity, description, affectedScope ?? null],
    "insert_security_incident",
  );
  return result.rows[0]?.id ?? "";
}

export async function createDataErasureRequest(
  userId: string,
  importerId?: string,
): Promise<string> {
  const requestId = `ERASE-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const slaDealine = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO data_erasure_requests (request_id, user_id, importer_id, sla_deadline, affected_fields)
     VALUES ($1, $2, $3, $4, ARRAY['legal_name', 'ein', 'email'])
     RETURNING id`,
    [requestId, userId, importerId ?? null, slaDealine],
    "insert_erasure_request",
  );
  return result.rows[0]?.id ?? "";
}
