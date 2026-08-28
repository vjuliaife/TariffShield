import { PoolClient } from 'pg';

// #1090 — index that a prior investigation (#257) intended to add but which
// never actually reached this migration runner.
//
// #257's closing PR added `idx_importers_created_at` only to the legacy,
// no-longer-executed `apps/api/migrations/007_hot_path_indexes.sql`. That
// file is read by nothing — `npm run migrate` / `db:migrate` only runs
// `src/migrations/000N_*.ts` via `src/migrations/runner.ts` — and the index
// doesn't exist in `0001_initial_schema.ts` or any other file here. Verified
// by grepping every `src/migrations/*.ts` file and `src/db.ts` for the index
// name: zero hits before this migration. So every database this pipeline has
// ever actually provisioned has been missing it.
//
// idx_importers_created_at supports `GET /importers` for surety_admin
// (`ORDER BY i.created_at DESC` with no WHERE clause,
// routes/importers.ts:189-197). Without it this is a sequential scan + sort
// that grows with the full importers table on every admin list load (#1090).
// See docs/investigations/importers-list-pagination-at-scale.md.
//
// (#1093 also investigated the similarly-unwired `idx_contract_events_raw_gin`
// from #238/005_contract_events_jsonb_gin.sql, and deliberately does NOT
// re-add it here — see docs/investigations/contract-events-gin-index-at-scale.md
// for why: nothing in this codebase ever writes or queries
// contract_events.raw, so the index would add write overhead with no read
// benefit.)
//
// Not using CONCURRENTLY: `src/migrations/runner.ts` wraps every migration's
// `up()` in a single `BEGIN`/`COMMIT`, and `CREATE INDEX CONCURRENTLY` cannot
// run inside a transaction block — Postgres rejects it outright.
// (`0005_scalability_indexes.ts` already uses CONCURRENTLY and would hit
// this same error if actually run through this runner — a pre-existing
// issue in that migration, unrelated to #1090, flagged separately rather
// than fixed here since changing runner.ts's transaction handling affects
// every migration, not just this one.) A plain CREATE INDEX briefly locks
// writers on `importers`, matching the precedent already set by
// 0002_partition_contract_events.ts's own non-concurrent
// `CREATE INDEX ... ON contract_events(...)`.

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_importers_created_at ON importers(created_at DESC);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_importers_created_at;`);
}
