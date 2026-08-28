# Investigation: `contract_events` JSONB GIN index at scale

Issue: #1093

## Summary

The issue's premise is that `idx_contract_events_raw_gin` (GIN index on
`contract_events.raw`, originally `apps/api/migrations/005_contract_events_jsonb_gin.sql`,
issue #238) "is used by admin event and importer event queries," and asks
whether its scan performance and size hold up at 10x event volume.

Two things turned up during this investigation that the issue itself
doesn't anticipate, both more fundamental than the scan-performance
question it asks:

## 1. The index was never actually applied to any real database

Same situation as #1090's `idx_importers_created_at` (see
`docs/investigations/importers-list-pagination-at-scale.md`): #238's
closing work added `idx_contract_events_raw_gin` only to
`apps/api/migrations/005_contract_events_jsonb_gin.sql`, a file nothing
executes. `npm run migrate` / `db:migrate` only runs
`src/migrations/000N_*.ts` via `src/migrations/runner.ts`. Grepped every
file in `src/migrations/` and `src/db.ts` for `raw_gin`/`USING GIN`/`GIN`:
zero hits anywhere. So every database this pipeline has ever actually
provisioned has never had this index — every query touching
`contract_events.raw`, if any existed, would be doing a sequential scan
across every partition today.

## 2. Nothing in the codebase writes or reads `contract_events.raw`

This is the more important finding. `raw JSONB` is declared on the table
(`0001_initial_schema.ts:46`, re-declared identically for the partitioned
table in `0002_partition_contract_events.ts:69,229`), but:

- **Every `INSERT INTO contract_events` in application code omits `raw`
  entirely** — checked all four insert call sites:
  `apps/api/src/queue.ts:163-165`, `apps/api/src/routes/importers.ts:166-169`
  and `:697-699`, `apps/api/src/routes/admin.ts:525-528`. None of their
  column lists include `raw`, so every row any of these paths create has
  `raw IS NULL`. (The only places `raw` appears at all are the
  copy-through-partition-cutover `INSERT ... SELECT ... raw ...` statements
  in `0002_partition_contract_events.ts:126-129,237-240`, which move
  whatever's already in the column — always NULL — rather than populate
  it.)
- **No `SELECT` anywhere filters, projects, or otherwise reads `raw`** —
  checked every route file and service under `apps/api/src`. The two
  endpoints the issue names as the JSONB-index consumers don't touch it:
  `GET /admin/events` (`importers.ts:231-292`) selects
  `id, importer_id, kind, amount, tx_hash, created_at, ledger_sequence,
event_index` and filters only on `created_at`;
  `GET /:id/events` (`importers.ts:434-475`) selects
  `id, kind, amount, tx_hash, created_at` and filters on `importer_id` and
  a keyset `id` cursor. Neither uses a JSONB containment operator (`@>`,
  `?`, `->`, `->>`) against `raw`, or against anything.

In other words: `contract_events.raw` is a column that's declared but
functionally dead in the current codebase — always NULL, never read. A GIN
index on an always-NULL column indexes nothing useful; it would still pay
its full write cost (index maintenance on every insert into the busiest
table in the schema, plus its own storage and VACUUM overhead) for zero
query benefit, since there's no query for it to accelerate.

## Recommendation

**Do not add `idx_contract_events_raw_gin`.** Doing so — even though it's
literally what #238/the legacy migration file describe, and even though
re-adding it might look like "finishing" that prior work — would be a pure
regression: write overhead on `contract_events` (already flagged as the
largest, partitioned-for-scale table in the schema, per
`0002_partition_contract_events.ts`'s own header comment) with no
corresponding read speedup, because nothing queries the column it would
index.

If a future feature actually starts writing structured event payloads into
`raw` and querying them with JSONB operators, add the GIN index at that
point, in the same change that introduces the read query — not
speculatively ahead of it. Until then, this issue's AC question ("does GIN
index scan performance hold up at 10x volume") doesn't apply: there is no
GIN-indexed scan happening, at any volume, because there's no index and no
query that would use one.

## Reproducing / measuring

No live Postgres instance was available in this environment to run the
JSONB containment query benchmarks, index-size, or vacuum/reindex-duration
measurements this issue's AC asks for. That's moot here regardless: those
measurements are about a query pattern (JSONB containment against `raw`)
that doesn't exist anywhere in this codebase to benchmark.

## Acceptance criteria status

- [ ] Benchmark JSONB containment query latency at current volume and
      simulated 10x volume — not applicable; no code path runs a JSONB
      containment query against `raw`
- [ ] Measure GIN index size and vacuum/reindex duration at scale — not
      applicable; the index doesn't exist in any real database this
      pipeline provisions, and shouldn't be added (see Recommendation)
- [ ] Compare planner choice between GIN index scan and sequential scan
      across volumes — not applicable, same reason
- [x] Recommend index tuning or partitioning if latency degrades — the
      recommendation is not to add the index at all; see above
- [x] Report findings in the issue — this document
