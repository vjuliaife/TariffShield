// #1126 — audit-log write-path benchmark (local Postgres only; no HTTP).
//
// Measures:
//   1. Single `audit_log` INSERT (the `logAudit()` pattern) at ~1x vs ~10x
//      table size, to check whether btree index maintenance makes the
//      append cost grow with the table.
//   2. The paired "domain write + audit entry" pattern that the API performs
//      today (two statements on an autocommit pool — e.g. the SAML
//      surety_admin upsert + a role_change audit row — which are NOT in one
//      transaction), vs the same pair wrapped in a single BEGIN/COMMIT.
//
// Run against a local database whose schema has been migrated:
//   node apps/api/tests/benchmarks/audit-log-write-path.js
//   # or
//   DATABASE_URL=postgres://... node apps/api/tests/benchmarks/audit-log-write-path.js
//
// The script seeds its own `users` + `audit_log` rows for a valid FK shape,
// and TRUNCATEs `audit_log` when done so the local DB stays clean.
import { Client } from 'pg';
import { config as dotenv } from 'dotenv';
import { randomBytes } from 'crypto';

dotenv({ path: new URL('../../../.env.local', import.meta.url) });
dotenv({ path: new URL('../../../.env', import.meta.url) });
dotenv({ path: new URL('../../.env', import.meta.url) });

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield';

const BASE_ROWS = 25_000;
const SCALE_ROWS = 250_000; // 10x
const ITERS = 300;
const PERCENTILE = 0.95;

function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function ms(ns) {
  return (ns / 1e6).toFixed(2);
}

function stats(label, samples) {
  const sum = samples.reduce((a, b) => a + b, 0);
  const p50 = pct(samples, 0.5);
  console.log(
    `${label.padEnd(46)} mean=${ms(sum / samples.length).padStart(7)}ms  p50=${ms(p50).padStart(7)}ms  p95=${ms(
      pct(samples, PERCENTILE)
    ).padStart(7)}ms  (n=${samples.length})`
  );
  return { meanMs: sum / samples.length / 1e6, p50Ms: p50 / 1e6 };
}

async function auditInsert(client, actorUserId) {
  await client.query(
    `INSERT INTO audit_log (actor_user_id, action, target_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [
      actorUserId,
      'role_assigned',
      randomBytes(16).toString('hex'),
      { role: 'surety_admin', seed: 'bench' },
    ]
  );
}

async function fillAuditRows(client, count, actorUserId) {
  // Fast path: insert in bulk batches (no generated rows needed, small payloads).
  const batch = 5_000;
  for (let b = 0; b < count / batch; b++) {
    const values = [];
    for (let i = 0; i < batch; i++) {
      values.push(
        `('${randomBytes(16).toString('hex')}', '${actorUserId}', 'seed', '${JSON.stringify({ seed: true })}')`
      );
    }
    await client.query(
      `INSERT INTO audit_log (id, actor_user_id, action, payload) VALUES ${values.join(',')}`
    );
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const schema = await client.query(
    `SELECT to_regclass('public.audit_log') AS has_table, to_regclass('public.users') AS has_users`
  );
  if (!schema.rows[0].has_table || !schema.rows[0].has_users) {
    console.error('audit_log / users do not exist — run migrations first (npm run migrate).');
    process.exit(1);
  }

  const user = await client.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'surety_admin') ON CONFLICT (email) DO NOTHING RETURNING id`,
    [`bench.audit.write@example.com`, 'bench-placeholder']
  );
  const actorUserId =
    user.rows[0]?.id ??
    (
      await client.query(
        `SELECT id FROM users WHERE email = 'bench.audit.write@example.com' LIMIT 1`
      )
    ).rows[0].id;

  // ---- Part 1: audit_log INSERT latency at 1x vs 10x table size ------------
  await client.query('TRUNCATE audit_log');
  await fillAuditRows(client, BASE_ROWS, actorUserId);
  const countBase = (await client.query(`SELECT count(*)::int AS c FROM audit_log`)).rows[0].c;

  const samplesBase = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    await auditInsert(client, actorUserId);
    samplesBase.push(Number(process.hrtime.bigint() - t0));
  }

  await fillAuditRows(client, SCALE_ROWS, actorUserId);
  const countScaled = (await client.query(`SELECT count(*)::int AS c FROM audit_log`)).rows[0].c;
  const sizeBase = (await client.query(`SELECT pg_total_relation_size('audit_log') AS size`))
    .rows[0].size;
  const samplesScaled = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    await auditInsert(client, actorUserId);
    samplesScaled.push(Number(process.hrtime.bigint() - t0));
  }
  const sizeScaled = (await client.query(`SELECT pg_total_relation_size('audit_log') AS size`))
    .rows[0].size;

  console.log('\n#1126 — audit-log write path (local docker Postgres 17)');
  console.log(
    `audit_log rows: base=${countBase}, scaled=${countScaled} (x${(countScaled / countBase).toFixed(1)})`
  );
  console.log(
    `audit_log size: base=${(sizeBase / 1e6).toFixed(1)}MB, scaled=${(sizeScaled / 1e6).toFixed(1)}MB\n`
  );

  const base = stats('single audit_log INSERT @ ~1x size', samplesBase);
  const scaled = stats('single audit_log INSERT @ ~10x size', samplesScaled);

  // ---- Part 2: paired domain write + audit entry ---------------------------
  // Autocommit (today's reality): the domain write and the audit insert are
  // two separate pool statements.
  const samplesPairAuto = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    await client.query(
      `INSERT INTO users (email, password_hash, role, saml_subject_id, idp_entity_id, idp_provider)
       VALUES ($1, $2, 'surety_admin', $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         saml_subject_id = EXCLUDED.saml_subject_id,
         idp_entity_id   = EXCLUDED.idp_entity_id,
         idp_provider    = EXCLUDED.idp_provider`,
      [`bench.saml.${i % 10}@example.com`, 'x', 'subj-' + i, 'idp', 'provider']
    );
    await auditInsert(client, actorUserId);
    samplesPairAuto.push(Number(process.hrtime.bigint() - t0));
  }

  // Same pair inside one transaction.
  const samplesPairTx = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (email, password_hash, role, saml_subject_id, idp_entity_id, idp_provider)
       VALUES ($1, $2, 'surety_admin', $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         saml_subject_id = EXCLUDED.saml_subject_id,
         idp_entity_id   = EXCLUDED.idp_entity_id,
         idp_provider    = EXCLUDED.idp_provider`,
      [`bench.saml.${i % 10}@example.com`, 'x', 'subj-' + i, 'idp', 'provider']
    );
    await auditInsert(client, actorUserId);
    await client.query('COMMIT');
    samplesPairTx.push(Number(process.hrtime.bigint() - t0));
  }

  console.log('\nPaired writes — users upsert (role) + audit_log insert:');
  const pairAuto = stats('autocommit (2 pool statements)', samplesPairAuto);
  const pairTx = stats('single transaction (BEGIN/COMMIT)', samplesPairTx);

  // ---- Summary arithmetic ---------------------------------------------------
  const auditPct = base.meanMs + scaled.meanMs;
  const overheadPct1x = (base.meanMs / pairAuto.meanMs) * 100;
  const txSavings = ((pairAuto.meanMs - pairTx.meanMs) / pairAuto.meanMs) * 100;

  console.log('\nFindings:');
  console.log(
    `  • audit INSERT latency change at 10x size: mean ${base.meanMs.toFixed(2)}ms → ${scaled.meanMs.toFixed(
      2
    )}ms (${((scaled.meanMs / base.meanMs - 1) * 100).toFixed(1)}%)`
  );
  console.log(`  • audit INSERT ≈ ${overheadPct1x.toFixed(1)}% of the autocommit pair latency`);
  console.log(
    `  • wrapping the pair in one transaction: ${txSavings.toFixed(1)}% faster (${pairAuto.p50Ms.toFixed(
      2
    )}ms → ${pairTx.p50Ms.toFixed(2)}ms p50)`
  );

  // Clean up local state.
  await client.query('TRUNCATE audit_log');
  await client.query(
    `DELETE FROM users WHERE email IN ('bench.audit.write@example.com') OR email LIKE 'bench.saml.%'`
  );
  await client.end();
  console.log('\n(cleanup done — audit_log truncated, bench users removed)');
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
