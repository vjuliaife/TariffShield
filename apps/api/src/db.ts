import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import pino from 'pino';
import client from 'prom-client';
import { env } from './config/env.js';

const logger = pino({ name: 'db' });

const url = new URL(env.DATABASE_URL);
const sslRequired = url.searchParams.get('sslmode') === 'require';

// Pool sizing (#241): max=20 by default caps concurrent connections well
// under PostgreSQL's default max_connections=100, leaving headroom for
// other API instances, migrations, and admin/monitoring connections when
// running multiple replicas. idleTimeoutMillis recycles idle clients so
// they don't sit open indefinitely; connectionTimeoutMillis fails fast
// instead of queuing forever when the pool is saturated; statement_timeout
// guards against a single runaway query holding a connection (and
// blocking the pool) indefinitely.
const basePool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONN_TIMEOUT_MS,
  statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  application_name: 'tariffshield-api',
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

const poolInterval = setInterval(() => {
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
if (typeof poolInterval.unref === 'function') {
  poolInterval.unref();
}

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
  connect: () => basePool.connect(),
  end: () => basePool.end(),
};

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/**
 * Snapshot of the pool's own connection counters, for the /health/db
 * endpoint (#241). These are always the source of truth — see the
 * Prometheus gauges above, which read the same values on scrape.
 */
export function getPoolStats(): PoolStats {
  return {
    totalCount: basePool.totalCount,
    idleCount: basePool.idleCount,
    waitingCount: basePool.waitingCount,
  };
}

// ── Schema migrations ─────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  const { runMigrations } = await import('./migrations/runner.js');
  await runMigrations('up');
}

export async function rollback(): Promise<void> {
  const { runMigrations } = await import('./migrations/runner.js');
  await runMigrations('rollback');
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
      -- #243: SHA-256 hex digest of ein, for PII-safe equality lookups
      -- (dedup checks, lookup-by-ein) without exposing the plaintext value.
      -- ein itself is scheduled for encryption (see the ein_encrypted /
      -- ein_key_version columns below, from the AES-GCM field-encryption
      -- work) — ein_hash lets lookups keep working once that lands.
      ein_hash TEXT,
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

    -- #228: this CREATE TABLE IF NOT EXISTS is only the pre-partition
    -- fallback shape, used by rollback()'s baseline-ensure safety net (it
    -- runs after a full migration rollback, so it must work against an
    -- empty database). It never runs against a database where 0002 has
    -- already partitioned contract_events, because IF NOT EXISTS makes it
    -- a no-op once the table exists in either form.
    --
    -- The authoritative, currently-applied shape is defined in
    -- migrations/0002_partition_contract_events.ts: contract_events is
    -- PARTITION BY RANGE (created_at) with one child table per calendar
    -- month (contract_events_YYYY_MM, plus a DEFAULT partition as a safety
    -- net), PRIMARY KEY (id, created_at) — Postgres requires the partition
    -- key in any PK/unique constraint declared on a partitioned table —
    -- and monthly partitions are kept pre-created by
    -- jobs/ensure-contract-events-partitions.ts. See that migration and
    -- lib/contract-events-partitions.ts for the full rationale, including
    -- why the ledger_sequence/event_index uniqueness guard below has to be
    -- a local per-partition index rather than a single index on the
    -- parent.
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

    -- #248: B-tree index on contract_events (importer_id, id DESC) to support high-performance cursor-based pagination.
    CREATE INDEX IF NOT EXISTS idx_contract_events_importer_id_pagination ON contract_events(importer_id, id DESC);

    -- #245: BRIN index on contract_events.created_at for time-range queries.
    -- A B-tree index stores pointers for every single row and becomes extremely large at scale.
    -- A BRIN (Block Range Index) index summarizes block ranges (minimum/maximum timestamps per range of pages),
    -- resulting in a footprint that is orders of magnitude smaller (typically ~1:800 or 99.8% smaller).
    -- pages_per_range is set to 32 (down from default 128) to provide finer search granularity,
    -- which is highly effective for chronologically ordered event logs under high-volume ingestion.
    -- #228: this and the two importer-scoped indexes above are declared the
    -- same way on the authoritative partitioned table (migrations/0002_
    -- partition_contract_events.ts) — indexes created on a partitioned
    -- parent automatically propagate to every current and future partition.
    CREATE INDEX IF NOT EXISTS idx_contract_events_created_at_brin ON contract_events USING BRIN (created_at) WITH (pages_per_range = 32);


    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS ledger_sequence INTEGER;
    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS event_index INTEGER;

    -- #228: on the partitioned table this same uniqueness guard is instead a
    -- LOCAL index created individually per partition, not a single index on
    -- the parent — see lib/contract-events-partitions.ts for why.
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

    -- #229: supports admin-dashboard filtering by KYC status and the
    -- kyc_status = 'approved' guards added to the tariff-upload / deposit /
    -- auto-top-up / withdraw routes.
    CREATE INDEX IF NOT EXISTS idx_importers_kyc_status ON importers(kyc_status);

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

    -- #243: ein_hash for PII-safe equality lookups (see the importers table
    -- comment above). Partial unique index — NULL eins (optional field)
    -- never collide with each other or force uniqueness.
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_importers_ein_hash ON importers(ein_hash) WHERE ein_hash IS NOT NULL;

    -- One-time backfill: compute ein_hash for any pre-existing row that has
    -- a plaintext ein but no hash yet. Safe to re-run — only touches rows
    -- still missing ein_hash.
    UPDATE importers
      SET ein_hash = encode(sha256(ein::bytea), 'hex')
      WHERE ein IS NOT NULL AND ein_hash IS NULL;

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

    -- #992: dispute evidence attachments
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      dispute_id UUID NOT NULL REFERENCES collateral_disputes(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      file_name TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      s3_key_encrypted TEXT,
      virus_scan_status TEXT DEFAULT 'clean',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute
      ON dispute_evidence(dispute_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_importer
      ON dispute_evidence(importer_id, created_at DESC);

    -- #993: recurring deposit schedules
    CREATE TABLE IF NOT EXISTS deposit_schedules (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
      amount_stroops NUMERIC(20, 0) NOT NULL,
      bucket TEXT NOT NULL DEFAULT 'collateral' CHECK (bucket IN ('collateral', 'reserve')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
      next_run_at TIMESTAMPTZ NOT NULL,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_schedules_importer
      ON deposit_schedules(importer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposit_schedules_due
      ON deposit_schedules(next_run_at) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS deposit_schedule_executions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      schedule_id UUID NOT NULL REFERENCES deposit_schedules(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      amount_stroops NUMERIC(20, 0) NOT NULL,
      bucket TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
      job_id TEXT,
      error_message TEXT,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_schedule_executions_schedule
      ON deposit_schedule_executions(schedule_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposit_schedule_executions_importer
      ON deposit_schedule_executions(importer_id, executed_at DESC);

    -- #994: future-dated staged withdrawal scheduling
    CREATE TABLE IF NOT EXISTS scheduled_withdrawals (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_stroops NUMERIC(20, 0) NOT NULL,
      target_date TIMESTAMPTZ NOT NULL,
      target_address TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'blocked', 'cancelled')),
      execution_result TEXT,
      executed_at TIMESTAMPTZ,
      job_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_withdrawals_importer
      ON scheduled_withdrawals(importer_id, target_date ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_withdrawals_due
      ON scheduled_withdrawals(target_date) WHERE status = 'pending';

    -- #995: self-service API key management
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

    ALTER TABLE importers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE MATERIALIZED VIEW IF NOT EXISTS importer_metrics AS
    SELECT
      i.id AS importer_id,
      i.legal_name,
      i.stellar_address,
      COALESCE(t.latest_required_collateral, 0) AS required_collateral,
      COALESCE(
        SUM(CASE WHEN ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve') THEN ce.amount ELSE 0 END) -
        SUM(CASE WHEN ce.kind IN ('withdrawal', 'withdraw') THEN ce.amount ELSE 0 END), 0
      ) AS current_balance,
      COALESCE(t.latest_annual_duty_total, 0) AS annual_duty_total,
      CASE WHEN COALESCE(t.latest_required_collateral, 0) > 0
        THEN ROUND(
          (SUM(CASE WHEN ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve') THEN ce.amount ELSE 0 END) -
           SUM(CASE WHEN ce.kind IN ('withdrawal', 'withdraw') THEN ce.amount ELSE 0 END))::NUMERIC
          / t.latest_required_collateral, 4)
        ELSE NULL END AS coverage_ratio,
      now() AS refreshed_at
    FROM importers i
    LEFT JOIN LATERAL (
      SELECT annual_duty_total AS latest_annual_duty_total,
             computed_required_collateral AS latest_required_collateral
      FROM tariff_uploads WHERE importer_id = i.id ORDER BY created_at DESC LIMIT 1
    ) t ON true
    LEFT JOIN contract_events ce ON ce.importer_id = i.id
    WHERE i.deleted_at IS NULL
    GROUP BY i.id, i.legal_name, i.stellar_address,
             t.latest_annual_duty_total, t.latest_required_collateral;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_importer_metrics_importer_id
      ON importer_metrics (importer_id);

    -- Prevent UPDATE and DELETE on audit_log via row-level security
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    CREATE POLICY audit_log_no_update ON audit_log FOR UPDATE USING (false);
    CREATE POLICY audit_log_no_delete ON audit_log FOR DELETE USING (false);

    -- #232: bonds — full bond lifecycle tracking (supersedes importers.bond_id).
    -- See migrations/0004_supplementary_schema.ts for why importers.bond_id
    -- is deprecated but retained.
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

    -- #234: documents — bond application PDF storage metadata (CBP Form 301,
    -- power of attorney, commercial invoices, KYC ID, etc). Stores a reference
    -- to the object-storage location, not the file bytes. Distinct from
    -- kyc_documents (#312) below, which is specifically compliance
    -- paperwork (articles of incorporation, EIN confirmation, beneficial
    -- ownership) under its own retention/review workflow.
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('cbp_301', 'power_of_attorney', 'commercial_invoice', 'kyc_id', 'other')),
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      mime_type TEXT,
      size_bytes BIGINT,
      uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_documents_importer_kind ON documents(importer_id, kind, created_at DESC);

    -- #244: importer_documents_view — joins importers with kyc_documents and
    -- kyc_status in a single query for the surety admin review workflow, so
    -- every API handler that touches the review flow doesn't need to
    -- duplicate the JOIN. Depends on: kyc_status (#229), kyc_documents
    -- (#234), and ein_hash (#243) — all already applied above.
    -- importers.deleted_at (added by the importer_metrics work above) is
    -- now filtered on too, so soft-deleted importers never appear in admin
    -- review; kyc_documents' own deleted_at (its retention-schedule
    -- deletion, unrelated to importer soft-delete) is filtered separately
    -- so retention-expired documents don't appear either.
    -- A plain view, not materialized — reads always reflect current data,
    -- no refresh job needed (unlike importer_metrics_mv/importer_metrics above).
    CREATE OR REPLACE VIEW importer_documents_view AS
    SELECT
      i.id AS importer_id,
      i.legal_name,
      i.ein_hash,
      i.bond_id,
      i.stellar_address,
      i.kyc_status,
      i.created_at AS importer_created_at,
      d.id AS document_id,
      d.document_type,
      d.review_status AS document_review_status,
      d.reviewer_id,
      d.reviewer_note,
      d.reviewed_at AS document_reviewed_at,
      d.scheduled_deletion_date AS document_scheduled_deletion_date,
      d.created_at AS document_created_at
    FROM importers i
    LEFT JOIN kyc_documents d
      ON d.importer_id = i.id AND d.deleted_at IS NULL
    WHERE i.deleted_at IS NULL;
  `,
    undefined,
    'migrate_schema'
  );
  logger.info('schema ready');
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

/**
 * Refresh the importer_metrics materialized view concurrently without blocking reads.
 *
 * Refresh Cadence:
 * - Triggered on-demand inside the tariff upload POST handler (`/importers/:id/upload-tariff-csv`).
 * - Can also be run on a background timer or cron (e.g. every 5 minutes) to sync async
 *   on-chain ledger events (deposits, withdrawals, clawbacks).
 *
 * Staleness Window:
 * - Near-zero latency for tariff upload mutations since refresh is triggered immediately.
 * - Up to 5 minutes latency (or since last indexer run) for on-chain events if relying on periodic refresh.
 */
export async function refreshImporterMetricsView(): Promise<void> {
  await timedQuery(
    'REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics',
    undefined,
    'refresh_importer_metrics'
  );
}

// ── importer_documents_view (#244) ─────────────────────────────────────────────

export interface ImporterDocumentRow {
  documentId: string;
  documentType: string;
  reviewStatus: string;
  reviewerId: string | null;
  reviewerNote: string | null;
  reviewedAt: string | null;
  scheduledDeletionDate: string;
  createdAt: string;
}

export interface ImporterReview {
  importerId: string;
  legalName: string;
  einHash: string | null;
  bondId: string;
  stellarAddress: string;
  kycStatus: string;
  importerCreatedAt: string;
  documents: ImporterDocumentRow[];
}

/**
 * Fetch a single importer's profile plus every kyc_documents row attached to
 * it, from importer_documents_view — one query instead of the API handler
 * doing its own JOIN. Returns null if no importer with this id exists.
 * An importer with zero documents still returns (with documents: []) — the
 * view's LEFT JOIN produces a single row with all document_* fields NULL,
 * which this function filters out via the document_id IS NOT NULL check.
 */
export async function getImporterReview(importerId: string): Promise<ImporterReview | null> {
  const result = await timedQuery<{
    importer_id: string;
    legal_name: string;
    ein_hash: string | null;
    bond_id: string;
    stellar_address: string;
    kyc_status: string;
    importer_created_at: Date;
    document_id: string | null;
    document_type: string | null;
    document_review_status: string | null;
    reviewer_id: string | null;
    reviewer_note: string | null;
    document_reviewed_at: Date | null;
    document_scheduled_deletion_date: Date | null;
    document_created_at: Date | null;
  }>(
    'SELECT * FROM importer_documents_view WHERE importer_id = $1',
    [importerId],
    'select_importer_documents_view'
  );

  const first = result.rows[0];
  if (!first) {
    return null;
  }

  const documents: ImporterDocumentRow[] = result.rows
    .filter((row) => row.document_id !== null)
    .map((row) => ({
      documentId: row.document_id as string,
      documentType: row.document_type as string,
      reviewStatus: row.document_review_status as string,
      reviewerId: row.reviewer_id,
      reviewerNote: row.reviewer_note,
      reviewedAt: row.document_reviewed_at?.toISOString() ?? null,
      scheduledDeletionDate: (row.document_scheduled_deletion_date as Date).toISOString(),
      createdAt: (row.document_created_at as Date).toISOString(),
    }));

  return {
    importerId: first.importer_id,
    legalName: first.legal_name,
    einHash: first.ein_hash,
    bondId: first.bond_id,
    stellarAddress: first.stellar_address,
    kycStatus: first.kyc_status,
    importerCreatedAt: first.importer_created_at.toISOString(),
    documents,
  };
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
  payload: Record<string, unknown> | null
): Promise<void> {
  await timedQuery(
    `INSERT INTO audit_log (actor_user_id, action, target_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [actorUserId, action, targetId, payload ? JSON.stringify(payload) : null],
    'insert_audit_log'
  );
}

// ── #230: Notification helper ─────────────────────────────────────────────────
//
// Shared by any router that needs to raise an in-app notification for a user
// (routes/notifications.ts doesn't call this itself — it only reads/updates
// existing rows — but routes that produce the underlying events, like
// routes/importers.ts, do), mirroring how logAudit above is shared the same
// way for audit_log.
export async function createNotification(
  userId: string,
  kind: string,
  message: string
): Promise<void> {
  await timedQuery(
    `INSERT INTO notifications (user_id, kind, message)
     VALUES ($1, $2, $3)`,
    [userId, kind, message],
    'insert_notification'
  );
}

// ── #235: Refresh token helpers ─────────────────────────────────────────────

export async function createRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  userAgent?: string,
  ipAddress?: string
): Promise<string> {
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, tokenHash, expiresAt, userAgent ?? null, ipAddress ?? null],
    'insert_refresh_token'
  );
  return result.rows[0]!.id;
}

export async function validateRefreshToken(
  tokenHash: string
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  const result = await timedQuery<{ id: string; user_id: string; expires_at: Date }>(
    `SELECT id, user_id, expires_at FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
    'validate_refresh_token'
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

export async function rotateRefreshToken(
  oldId: string,
  newTokenHash: string,
  newExpiresAt: Date
): Promise<string> {
  const result = await timedQuery<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 RETURNING user_id`,
    [oldId],
    'revoke_refresh_token'
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) throw new Error('refresh token not found');

  return createRefreshToken(userId, newTokenHash, newExpiresAt);
}

export async function revokeRefreshToken(tokenHash: string): Promise<boolean> {
  const result = await timedQuery(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
    'revoke_refresh_token'
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
