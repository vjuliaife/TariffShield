import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import pino from 'pino';
import client from 'prom-client';
import { env } from './config/env.js';

const logger = pino({ name: 'db' });

const url = new URL(env.DATABASE_URL);
const sslRequired = url.searchParams.get('sslmode') === 'require';

const basePool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONN_TIMEOUT_MS,
});

// ── Pool monitoring (#264) ────────────────────────────────────────────────────

export const pgPoolEventsTotal = new client.Counter({
  name: 'pg_pool_events_total',
  help: 'Total count of PostgreSQL pool lifecycle events',
  labelNames: ['event'],
});

// Gauges read the pool's own counters on scrape rather than being tracked by
// hand — `pool.totalCount`/`idleCount`/`waitingCount` are always the source
// of truth, so there's no risk of manual increment/decrement drift.
new client.Gauge({
  name: 'pg_pool_active',
  help: 'Number of PostgreSQL pool clients currently checked out (in use)',
  collect() {
    this.set(basePool.totalCount - basePool.idleCount);
  },
});

new client.Gauge({
  name: 'pg_pool_idle',
  help: 'Number of idle PostgreSQL pool clients available for reuse',
  collect() {
    this.set(basePool.idleCount);
  },
});

new client.Gauge({
  name: 'pg_pool_waiting',
  help: 'Number of queued requests waiting for a PostgreSQL pool client',
  collect() {
    this.set(basePool.waitingCount);
  },
});

basePool.on('connect', () => pgPoolEventsTotal.inc({ event: 'connect' }));
basePool.on('acquire', () => pgPoolEventsTotal.inc({ event: 'acquire' }));
basePool.on('remove', () => pgPoolEventsTotal.inc({ event: 'remove' }));
basePool.on('error', (err) => {
  pgPoolEventsTotal.inc({ event: 'error' });
  logger.error({ err }, 'PostgreSQL pool error (idle client)');
});

// Alert when the pool is under sustained exhaustion pressure: waitingCount > 5
// for more than 10 consecutive seconds. Checked every second; resets the
// streak the moment waitingCount drops back to <= 5, and only logs once per
// breach (not on every tick past 10s) to avoid alert spam.
const WAITING_ALERT_THRESHOLD = 5;
const WAITING_ALERT_DURATION_MS = 10_000;
const POOL_CHECK_INTERVAL_MS = 1_000;
let waitingBreachSince: number | null = null;
let waitingAlertFired = false;

setInterval(() => {
  const waiting = basePool.waitingCount;
  if (waiting > WAITING_ALERT_THRESHOLD) {
    if (waitingBreachSince === null) {
      waitingBreachSince = Date.now();
    } else if (!waitingAlertFired && Date.now() - waitingBreachSince >= WAITING_ALERT_DURATION_MS) {
      waitingAlertFired = true;
      logger.error(
        { waiting, thresholdSeconds: WAITING_ALERT_DURATION_MS / 1000 },
        `PostgreSQL pool exhaustion: ${waiting} requests waiting for >${WAITING_ALERT_DURATION_MS / 1000}s`
      );
    }
  } else {
    waitingBreachSince = null;
    waitingAlertFired = false;
  }
}, POOL_CHECK_INTERVAL_MS);

// ── Prometheus metrics (#373) ─────────────────────────────────────────────────

export const dbQueryDurationSeconds = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of PostgreSQL queries in seconds',
  labelNames: ['query_name'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const dbSlowQueriesTotal = new client.Counter({
  name: 'db_slow_queries_total',
  help: 'Total number of slow PostgreSQL queries',
  labelNames: ['threshold'],
});

// ── Query timing wrapper ──────────────────────────────────────────────────────

const SLOW_WARN_MS = 500;
const SLOW_ERROR_MS = 2000;
const SQL_TRUNCATE_LEN = 500;

function sanitizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/'[^']*'/g, "'?'")
    .slice(0, SQL_TRUNCATE_LEN);
}

function inferQueryName(sql: string): string {
  const s = sql.trim().toUpperCase();
  const m = s.match(
    /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+(?:INTO\s+|FROM\s+|TABLE\s+)?(\w+)?/
  );
  return m ? `${m[1]!.toLowerCase()}${m[2] ? `_${m[2]!.toLowerCase()}` : ''}` : 'unknown';
}

async function timedQuery<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[],
  queryName?: string
): Promise<QueryResult<R>> {
  const start = Date.now();
  const name = queryName ?? inferQueryName(sql);
  const endTimer = dbQueryDurationSeconds.startTimer({ query_name: name });

  try {
    const result = await basePool.query<R>(sql, values);
    const durationMs = Date.now() - start;
    endTimer();

    if (durationMs >= SLOW_ERROR_MS) {
      dbSlowQueriesTotal.inc({ threshold: '2000ms' });
      logger.error(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        'critically slow query'
      );
    } else if (durationMs >= SLOW_WARN_MS) {
      dbSlowQueriesTotal.inc({ threshold: '500ms' });
      logger.warn(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        'slow query'
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
    -- #227: compound index for kind-filtered event queries (deposit, withdrawal, clawback, etc.)
    -- The existing idx_contract_events_importer covers queries without a kind filter;
    -- this index adds kind as the second column for efficient type-specific lookups.
    CREATE INDEX IF NOT EXISTS idx_contract_events_importer_kind ON contract_events(importer_id, kind, created_at DESC);

    -- #245: BRIN index on contract_events.created_at for time-range queries.
    -- A B-tree index stores pointers for every single row and becomes extremely large at scale.
    -- A BRIN (Block Range Index) index summarizes block ranges (minimum/maximum timestamps per range of pages),
    -- resulting in a footprint that is orders of magnitude smaller (typically ~1:800 or 99.8% smaller).
    -- pages_per_range is set to 32 (down from default 128) to provide finer search granularity,
    -- which is highly effective for chronologically ordered event logs under high-volume ingestion.
    -- If contract_events is partitioned by month (Issue #228), parent indexes automatically propagate
    -- to all child partitions.
    CREATE INDEX IF NOT EXISTS idx_contract_events_created_at_brin ON contract_events USING BRIN (created_at) WITH (pages_per_range = 32);


    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS ledger_sequence INTEGER;
    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS event_index INTEGER;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_events_ledger_event
      ON contract_events(ledger_sequence, event_index)
      WHERE ledger_sequence IS NOT NULL AND event_index IS NOT NULL;

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

    -- #325: Automated DAST and security findings
    CREATE TABLE IF NOT EXISTS security_findings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
      affected_endpoint TEXT,
      discovery_date TIMESTAMPTZ NOT NULL DEFAULT now(),
      remediation_sla TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'accepted_risk')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_security_findings_status_severity ON security_findings(status, severity);

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

    -- #308: SAML 2.0 SSO columns on users table
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saml_subject_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_entity_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_provider TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_saml_subject ON users(saml_subject_id, idp_entity_id)
      WHERE saml_subject_id IS NOT NULL;

    -- #321: Terms of Service versioning and tracking
    CREATE TABLE IF NOT EXISTS tos_versions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      version_id TEXT UNIQUE NOT NULL,
      effective_date DATE NOT NULL,
      change_summary TEXT NOT NULL,
      requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tos_acceptances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      tos_version TEXT NOT NULL REFERENCES tos_versions(version_id),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip_address TEXT,
      user_agent TEXT,
      acceptance_method TEXT NOT NULL CHECK (acceptance_method IN ('signup', 're-acceptance'))
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_reacceptance_required BOOLEAN NOT NULL DEFAULT FALSE;

    -- Insert an initial ToS version if it doesn't exist
    INSERT INTO tos_versions (version_id, effective_date, change_summary)
      VALUES ('v1.0.0', CURRENT_DATE, 'Initial Terms of Service')
      ON CONFLICT (version_id) DO NOTHING;

    -- #322: privacy policy versioning
    CREATE TABLE IF NOT EXISTS privacy_policy_versions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      version_id TEXT UNIQUE NOT NULL,
      effective_date DATE NOT NULL,
      policy_text TEXT,
      s3_key TEXT,
      change_summary TEXT NOT NULL,
      requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
      published_by UUID REFERENCES users(id),
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS privacy_policy_acceptances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      policy_version_id TEXT NOT NULL REFERENCES privacy_policy_versions(version_id),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip_address TEXT,
      acceptance_channel TEXT NOT NULL DEFAULT 'signup'
        CHECK (acceptance_channel IN ('signup', 'in_app', 'api')),
      UNIQUE (user_id, policy_version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_privacy_acceptances_user ON privacy_policy_acceptances(user_id, accepted_at DESC);

    -- Track whether re-acceptance is outstanding (cleared when user accepts latest)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_reacceptance_required BOOLEAN NOT NULL DEFAULT FALSE;

    -- #317: electronic bond signatures (DocuSign)
    CREATE TABLE IF NOT EXISTS bond_signatures (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      bond_record_id UUID NOT NULL REFERENCES bond_records(id) ON DELETE CASCADE,
      envelope_id TEXT UNIQUE NOT NULL,
      signing_url TEXT,
      status TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sent', 'delivered', 'completed', 'declined', 'voided')),
      signed_document_hash TEXT,
      completed_at TIMESTAMPTZ,
      pdf_s3_key TEXT,
      last_reminder_sent_at TIMESTAMPTZ
    );

    -- #312: KYC document storage with retention schedule
    CREATE TABLE IF NOT EXISTS kyc_documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL CHECK (document_type IN ('articles_of_incorporation', 'ein_confirmation', 'beneficial_ownership_fincen_102')),
      s3_key_encrypted TEXT NOT NULL,
      upload_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
      reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewer_note TEXT,
      reviewed_at TIMESTAMPTZ,
      scheduled_deletion_date TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_kyc_documents_importer ON kyc_documents(importer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kyc_documents_deletion ON kyc_documents(scheduled_deletion_date) WHERE deleted_at IS NULL;

    -- KYC status column on importers (pending/approved/rejected)
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (kyc_status IN ('pending', 'approved', 'rejected'));

    -- #314: field encryption key version tracking
    CREATE TABLE IF NOT EXISTS field_encryption_key_versions (
      key_version INTEGER PRIMARY KEY,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_at TIMESTAMPTZ,
      notes TEXT
    );
    INSERT INTO field_encryption_key_versions (key_version, notes)
      VALUES (1, 'initial key version')
      ON CONFLICT (key_version) DO NOTHING;

    -- EIN is now stored as AES-256-GCM JSON; migrate existing plain text at app layer
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_encrypted TEXT;
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_key_version INTEGER REFERENCES field_encryption_key_versions(key_version);

    -- #318: regulatory compliance flags
    CREATE TABLE IF NOT EXISTS compliance_flags (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      flag_type TEXT NOT NULL CHECK (flag_type IN ('aml_high_risk', 'bond_below_cbp_minimum', 'bond_unsigned', 'kyc_rejected', 'bond_renewal_due')),
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      description TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved')),
      resolved_by UUID REFERENCES users(id),
      resolution_note TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bond_signatures_bond ON bond_signatures(bond_record_id);
    CREATE INDEX IF NOT EXISTS idx_bond_signatures_status ON bond_signatures(status, created_at DESC);

    -- Track bond signature status on bond_records for fast lookup
    ALTER TABLE bond_records ADD COLUMN IF NOT EXISTS signature_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (signature_status IN ('pending', 'sent', 'completed'));
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_surety ON compliance_flags(surety_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_importer ON compliance_flags(importer_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_open ON compliance_flags(surety_id, resolution_status) WHERE resolution_status = 'open';

    -- #319: monthly compliance reports
    CREATE TABLE IF NOT EXISTS compliance_reports (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_month DATE NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      report_data JSONB NOT NULL,
      pdf_s3_key TEXT,
      superseded_at TIMESTAMPTZ,
      UNIQUE (surety_id, report_month)
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_reports_surety ON compliance_reports(surety_id, report_month DESC);

    -- #324: insurance license verification for surety_admin accounts
    -- A surety_admin is created with status='pending'; operational routes are blocked
    -- until a platform admin sets status='verified' after checking NAIC / state DOI records.
    CREATE TABLE IF NOT EXISTS surety_license_verifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      naic_number TEXT,
      company_name TEXT NOT NULL DEFAULT '',
      state_of_domicile TEXT NOT NULL DEFAULT '',
      am_best_rating TEXT,
      license_status_detail TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted', 'verified', 'rejected')),
      submitted_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_surety_license_verifications_status
      ON surety_license_verifications(status, created_at DESC);

    -- #336: off-chain tracking of on-chain collateral disputes
    CREATE TABLE IF NOT EXISTS collateral_disputes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      old_required NUMERIC(20, 0) NOT NULL,
      new_required NUMERIC(20, 0) NOT NULL,
      raise_tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved_accepted', 'resolved_rejected')),
      raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolve_tx_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_collateral_disputes_importer
      ON collateral_disputes(importer_id, raised_at DESC);

    -- Oracle price feed: durable audit trail of every set_required_collateral event.
    CREATE TABLE IF NOT EXISTS oracle_price_feed (
      id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id          UUID          REFERENCES importers(id) ON DELETE SET NULL,
      importer_address     TEXT          NOT NULL,
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

    -- Checkpoint for the oracle event listener (resume after downtime).
    CREATE TABLE IF NOT EXISTS listener_state (
      id                   TEXT         PRIMARY KEY,
      last_ledger_sequence INTEGER      NOT NULL,
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
    );

    -- #306 SOC 2 CC6: server-side session table for 15-min inactivity timeout and
    -- concurrent session limits. Sessions are created on login and revoked on logout.
    CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_activity TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      ip_address TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
      ON user_sessions(user_id) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS surety_state_licenses (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      license_number TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (surety_id, state_code)
    );

    CREATE TABLE IF NOT EXISTS regulatory_report_audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      output_format TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_surety_state_licenses_surety ON surety_state_licenses(surety_id, state_code);
    CREATE INDEX IF NOT EXISTS idx_regulatory_report_audit_logs_surety ON regulatory_report_audit_logs(surety_id, generated_at DESC);

    ALTER TABLE bond_records ADD COLUMN IF NOT EXISTS state_code TEXT NOT NULL DEFAULT 'CA';
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS business_state TEXT NOT NULL DEFAULT 'CA';

    -- #251: surety-dashboard aggregate statistics, pre-computed instead of a
    -- live GROUP BY over importers/bond_records/contract_events on every
    -- page load. See apps/api/migrations/002_importer_metrics_mv.sql for the
    -- full metric-definition rationale.
    CREATE MATERIALIZED VIEW IF NOT EXISTS importer_metrics_mv AS
    SELECT
      1 AS singleton_id,
      (SELECT COUNT(*) FROM importers) AS total_importers,
      (SELECT COALESCE(SUM(bond_amount), 0) FROM bond_records) AS total_bond_value,
      (SELECT ROUND(COALESCE(AVG(collateral_balance), 0)) FROM importers) AS avg_balance,
      (
        SELECT CASE WHEN COUNT(*) = 0 THEN 100.0
          ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE bond_amount >= cbp_minimum_required) / COUNT(*), 2)
        END
        FROM bond_records
      ) AS compliance_rate,
      (
        SELECT COUNT(*) FROM contract_events
        WHERE kind IN ('deposit_collateral', 'deposit_reserve', 'auto_top_up')
          AND created_at >= now() - INTERVAL '30 days'
      ) AS topup_count_30d,
      now() AS refreshed_at;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_importer_metrics_mv_singleton
      ON importer_metrics_mv (singleton_id);

    -- #231: audit_log — append-only immutable action history for SOC 2 compliance
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_id, created_at DESC);

    -- Prevent UPDATE and DELETE on audit_log via row-level security
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    CREATE POLICY audit_log_no_update ON audit_log FOR UPDATE USING (false);
    CREATE POLICY audit_log_no_delete ON audit_log FOR DELETE USING (false);

    -- #232: bonds — full bond lifecycle tracking (supersedes importers.bond_id)
    -- NOTE: importers.bond_id is deprecated and retained for backward compatibility.
    -- All new bond queries should use the bonds table instead.
    CREATE TABLE IF NOT EXISTS bonds (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      bond_number BIGINT NOT NULL,
      policy_type TEXT NOT NULL DEFAULT 'continuous' CHECK (policy_type IN ('continuous', 'single_entry', 'term')),
      coverage_amount NUMERIC(20, 2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired', 'cancelled', 'replaced')),
      issued_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      replaced_by_id UUID REFERENCES bonds(id),
      stellar_contract_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bonds_bond_number ON bonds(bond_number);
    CREATE INDEX IF NOT EXISTS idx_bonds_importer_status ON bonds(importer_id, status, created_at DESC);

    -- Migrate existing importers.bond_id values into bonds table
    INSERT INTO bonds (importer_id, bond_number, policy_type, coverage_amount, status, issued_at, created_at)
    SELECT id, bond_id, 'continuous', 0, 'active', created_at, created_at
    FROM importers
    WHERE NOT EXISTS (SELECT 1 FROM bonds WHERE bond_number = importers.bond_id);

    -- #235: refresh_tokens — JWT refresh token flow with server-side revocation
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by_id UUID REFERENCES refresh_tokens(id),
      user_agent TEXT,
      ip_address INET,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE revoked_at IS NULL;
  `,
    undefined,
    'migrate_schema'
  );
  console.log('[migrate] schema ready');
}

// ── importer_metrics_mv (#251) ────────────────────────────────────────────────

export interface ImporterMetrics {
  totalImporters: number;
  totalBondValue: string;
  avgBalance: string;
  complianceRate: number;
  topupCount30d: number;
  refreshedAt: string;
}

/**
 * Read the pre-computed dashboard statistics from importer_metrics_mv.
 * Backed by a unique index on the (single-row) view, so this is a fast
 * indexed lookup rather than a live aggregate — target < 5ms p95.
 */
export async function getImporterMetrics(): Promise<ImporterMetrics> {
  const result = await timedQuery<{
    total_importers: number;
    total_bond_value: string;
    avg_balance: string;
    compliance_rate: string;
    topup_count_30d: number;
    refreshed_at: Date;
  }>(
    'SELECT * FROM importer_metrics_mv WHERE singleton_id = 1',
    undefined,
    'select_importer_metrics_mv'
  );

  const row = result.rows[0];
  if (!row) {
    return {
      totalImporters: 0,
      totalBondValue: '0',
      avgBalance: '0',
      complianceRate: 100,
      topupCount30d: 0,
      refreshedAt: new Date(0).toISOString(),
    };
  }

  return {
    totalImporters: row.total_importers,
    totalBondValue: row.total_bond_value,
    avgBalance: row.avg_balance,
    complianceRate: Number(row.compliance_rate),
    topupCount30d: row.topup_count_30d,
    refreshedAt: row.refreshed_at.toISOString(),
  };
}

/**
 * Refresh importer_metrics_mv without blocking concurrent reads.
 * Requires the unique index created alongside the view (see migrate()).
 */
export async function refreshImporterMetrics(): Promise<void> {
  await timedQuery(
    'REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics_mv',
    undefined,
    'refresh_importer_metrics_mv'
  );
}

export async function getLastProcessedLedger(): Promise<number | null> {
  const result = await timedQuery<{ last_processed_ledger: number }>(
    'SELECT last_processed_ledger FROM indexer_state WHERE id = $1',
    ['default'],
    'select_indexer_state'
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
    ['default', ledger],
    'upsert_indexer_state'
  );
}

/**
 * Pings the database to check if it's alive.
 */
export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * Returns all bonds that have been registered on-chain.
 */
export async function getActiveBonds(): Promise<
  { bondId: string; stellarAddress: string; dbBalance: string }[]
> {
  const result = await pool.query<{
    bond_id: string;
    stellar_address: string;
    collateral_balance: string;
  }>(
    'SELECT bond_id, stellar_address, collateral_balance FROM importers WHERE registered_on_chain_tx IS NOT NULL'
  );
  return result.rows.map((row) => ({
    bondId: row.bond_id,
    stellarAddress: row.stellar_address,
    dbBalance: row.collateral_balance,
  }));
}

export async function recordAuthenticationAttempt(
  email: string,
  success: boolean,
  userId?: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await timedQuery(
    `INSERT INTO authentication_attempts (email, success, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, success, userId ?? null, ipAddress ?? null, userAgent ?? null],
    'insert_auth_attempt'
  );
}

export async function getFailedAuthAttempts(
  email: string,
  withinMinutes: number = 30
): Promise<number> {
  const result = await timedQuery<{ count: string }>(
    `SELECT COUNT(*) as count FROM authentication_attempts
     WHERE email = $1 AND success = FALSE
     AND attempted_at > now() - INTERVAL '${withinMinutes} minutes'`,
    [email],
    'count_failed_auth_attempts'
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function lockAccountTemporarily(
  userId: string,
  durationMinutes: number = 30
): Promise<void> {
  await timedQuery(
    `UPDATE users SET locked_until = now() + INTERVAL '${durationMinutes} minutes'
     WHERE id = $1`,
    [userId],
    'lock_account'
  );
}

export async function recordSecurityIncident(
  severity: 'P0' | 'P1' | 'P2' | 'P3',
  description: string,
  affectedScope?: string
): Promise<string> {
  const incidentId = `INC-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO security_incidents (incident_id, severity, description, affected_scope)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [incidentId, severity, description, affectedScope ?? null],
    'insert_security_incident'
  );
  return result.rows[0]?.id ?? '';
}

export async function createDataErasureRequest(
  userId: string,
  importerId?: string
): Promise<string> {
  const requestId = `ERASE-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const slaDealine = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO data_erasure_requests (request_id, user_id, importer_id, sla_deadline, affected_fields)
     VALUES ($1, $2, $3, $4, ARRAY['legal_name', 'ein', 'email'])
     RETURNING id`,
    [requestId, userId, importerId ?? null, slaDealine],
    'insert_erasure_request'
  );
  return result.rows[0]?.id ?? '';
}

// ── SOC 2 CC6 — Session management (#306) ────────────────────────────────────

const SESSION_INACTIVITY_MINUTES = 15;

export async function createSession(
  userId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<string> {
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO user_sessions (user_id, ip_address, user_agent)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, ipAddress ?? null, userAgent ?? null],
    'insert_user_session'
  );
  return result.rows[0]!.id;
}

export async function validateSession(sessionId: string): Promise<boolean> {
  const result = await timedQuery<{ id: string }>(
    `SELECT id FROM user_sessions
     WHERE id = $1
       AND revoked_at IS NULL
       AND last_activity > now() - INTERVAL '${SESSION_INACTIVITY_MINUTES} minutes'`,
    [sessionId],
    'validate_user_session'
  );
  return (result.rowCount ?? 0) > 0;
}

export function touchSession(sessionId: string): void {
  timedQuery(
    'UPDATE user_sessions SET last_activity = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
    'touch_user_session'
  ).catch(() => {});
}

export async function revokeSession(sessionId: string): Promise<void> {
  await timedQuery(
    'UPDATE user_sessions SET revoked_at = now() WHERE id = $1',
    [sessionId],
    'revoke_user_session'
  );
}

export async function getActiveSessionCount(userId: string): Promise<number> {
  const result = await timedQuery<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
       AND last_activity > now() - INTERVAL '${SESSION_INACTIVITY_MINUTES} minutes'`,
    [userId],
    'count_active_sessions'
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function revokeOldestSession(userId: string): Promise<void> {
  await timedQuery(
    `UPDATE user_sessions SET revoked_at = now()
     WHERE id = (
       SELECT id FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY last_activity ASC
       LIMIT 1
     )`,
    [userId],
    'revoke_oldest_session'
  );
}

// ── #231: Audit log helper ──────────────────────────────────────────────────

export async function logAudit(
  actorUserId: string | null,
  action: string,
  targetId: string | null,
  payload: Record<string, unknown> | null,
): Promise<void> {
  await timedQuery(
    `INSERT INTO audit_log (actor_user_id, action, target_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [actorUserId, action, targetId, payload ? JSON.stringify(payload) : null],
    "insert_audit_log",
  );
}

// ── #235: Refresh token helpers ─────────────────────────────────────────────

export async function createRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  userAgent?: string,
  ipAddress?: string,
): Promise<string> {
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, tokenHash, expiresAt, userAgent ?? null, ipAddress ?? null],
    "insert_refresh_token",
  );
  return result.rows[0]!.id;
}

export async function validateRefreshToken(
  tokenHash: string,
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  const result = await timedQuery<{ id: string; user_id: string; expires_at: Date }>(
    `SELECT id, user_id, expires_at FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
    "validate_refresh_token",
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

export async function rotateRefreshToken(
  oldId: string,
  newTokenHash: string,
  newExpiresAt: Date,
): Promise<string> {
  const result = await timedQuery<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 RETURNING user_id`,
    [oldId],
    "revoke_refresh_token",
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) throw new Error("refresh token not found");

  return createRefreshToken(userId, newTokenHash, newExpiresAt);
}

export async function revokeRefreshToken(tokenHash: string): Promise<boolean> {
  const result = await timedQuery(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
    "revoke_refresh_token",
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getStaleAccounts(
  days: number
): Promise<Array<{ id: string; email: string; last_login: string | null }>> {
  const result = await timedQuery<{ id: string; email: string; last_login: string | null }>(
    `SELECT u.id, u.email,
            MAX(a.attempted_at) AS last_login
       FROM users u
       LEFT JOIN authentication_attempts a
         ON a.user_id = u.id AND a.success = TRUE
      GROUP BY u.id, u.email
     HAVING MAX(a.attempted_at) IS NULL
         OR MAX(a.attempted_at) < now() - ($1::integer * INTERVAL '1 day')
      ORDER BY last_login ASC NULLS FIRST`,
    [days],
    'select_stale_accounts'
  );
  return result.rows;
}
