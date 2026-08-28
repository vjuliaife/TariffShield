# Investigation: `oracle_price_feed` write contention at high update frequency

Issue: #1092

## Summary

`oracle_price_feed` (`apps/api/src/migrations/0001_initial_schema.ts:368-389`)
is written by exactly one code path,
`insertOracleFeedRow()` (`apps/api/src/services/oracle-event-listener.ts:158-192`),
and read by `verify-oracle-data` (`importers.ts:956-1047`) and the admin
event/CSV routes (`apps/api/src/routes/admin.ts:256-390`).

## Why this table structurally does not have a write-contention problem

**It's insert-only, and every insert targets a brand-new row.** There is no
`UPDATE` anywhere in the codebase against `oracle_price_feed` (checked: the
only write is the single `INSERT` in `insertOracleFeedRow`). Postgres
row-level locks are acquired per-row on `UPDATE`/`DELETE`/`SELECT ... FOR
UPDATE`; concurrent `INSERT`s of distinct new rows never contend for the
same row lock, regardless of how frequently they happen.

**The primary key is a random UUID, not a monotonically increasing value.**
`id UUID PRIMARY KEY DEFAULT uuid_generate_v4()` spreads inserts across the
whole B-tree key space rather than concentrating them at the rightmost leaf
page the way a `SERIAL`/`BIGSERIAL` PK would. That's the opposite of a
contention risk — high-frequency inserts of monotonically increasing keys
are the classic case for "buffer lock on the rightmost index page"
contention; a random UUID PK avoids it structurally, at the cost of less
sequential physical layout (a tradeoff already made here, not one this
investigation is proposing to change).

**Duplicate suppression is index-backed, not lock-based.** Every insert
does `ON CONFLICT (tx_hash, importer_address) DO NOTHING`, backed by
`idx_oracle_price_feed_tx_importer` — a unique btree index. Postgres
resolves `ON CONFLICT DO NOTHING` via the index's own insertion path (a
brief index-page-level operation, not a table-level or advisory lock), so
this doesn't introduce contention beyond what any unique-indexed insert
already has.

**Concurrent readers are never blocked by concurrent writers.** Postgres
MVCC means plain `SELECT`s (which is all `verify-oracle-data` and the
admin routes do against this table — no `SELECT ... FOR UPDATE` anywhere)
read a consistent snapshot and never wait on in-flight `INSERT`s, at any
write frequency.

## Where a real bottleneck could plausibly show up instead

Not lock contention, but plain resource cost as insert _volume_ (not
_frequency_ of conflicting writes — there are none) grows:

- `idx_oracle_price_feed_importer (importer_id, created_at DESC)`,
  `idx_oracle_price_feed_ledger (ledger_sequence)`, and the unique
  `(tx_hash, importer_address)` index are three B-tree indexes maintained
  on every insert. That's a fixed per-row write-amplification cost
  (3 index entries per row), not a contention issue — it scales linearly
  with insert count, same as any indexed table.
- `admin.ts`'s CSV-export route (`apps/api/src/routes/admin.ts:338-390`)
  streams the _entire_ `oracle_price_feed ${where}` result set. Like
  #1090's `GET /importers`, an unbounded read against a fast-growing
  insert-only audit table is a real future-scaling question — but it's a
  read-size concern, not the write-contention this issue specifically
  asks about, so it's out of scope here rather than folded in as a
  drive-by fix.

## Recommendation

**No index or schema change is warranted based on this structural
analysis.** The table's design (insert-only, random UUID PK, index-backed
dedup, no row-level updates) already avoids the write-contention failure
modes that would show up under high-frequency concurrent price updates. If
production monitoring later shows real write-latency degradation despite
this, the next step would be capturing `pg_stat_activity`/`pg_locks`
during an actual burst — that requires live traffic or a realistic-load
staging environment, which this investigation didn't have available, and
which no amount of further code reading can substitute for.

## Reproducing / measuring

No live Postgres instance was available in this environment to run the
insert-throughput and concurrent-read-latency benchmarks this issue's AC
asks for. The conclusion above is a structural analysis of the schema and
every write/read call site (grepped exhaustively — `insertOracleFeedRow` is
the only write), not a measured result.

## Acceptance criteria status

- [ ] Benchmark insert throughput on oracle_price_feed at increasing update
      frequencies — not possible without a live DB in this environment
- [ ] Measure read query latency for concurrent readers during heavy write
      bursts — same limitation; structurally, MVCC means writers don't
      block readers regardless of frequency (see above)
- [x] Identify lock type and duration for concurrent writers — none of
      consequence: distinct-row inserts never share a row lock, and the
      unique-index conflict check is index-level, not table-level
- [x] Recommend indexing or partitioning changes if contention is
      significant — no changes recommended; structural analysis found no
      contention mechanism for this table's access pattern
- [x] Report findings in the issue — this document
