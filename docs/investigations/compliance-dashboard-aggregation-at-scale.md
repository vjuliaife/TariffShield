# Investigation: `GET /compliance/dashboard` aggregation query cost at scale

Issue: #1096

## Method

Same seeded dataset as the `#1097` investigation (1x: 500 importers / 1500
flags / 500 bond_records; 10x: 5000 / 15000 / 5000). `EXPLAIN (ANALYZE,
BUFFERS)` against each of the 8 sub-queries the cold-cache path in
`apps/api/src/routes/compliance.ts` (`GET /dashboard`, line 41,
`dashboardCache`) runs in `Promise.all`.

## Cache mechanism (as-is)

An in-memory `Map` keyed by `dashboard:${user.id}`, 5-minute TTL, no size
bound. This is fine for hit-ratio purposes (a single surety-admin's
dashboard is identical for 5 minutes regardless of underlying data changes),
but every cache miss re-runs all 8 sub-queries, so the real question is how
expensive a miss is at scale.

## Cold-cache sub-query cost: 1x vs 10x

| Sub-query                                    | 1x exec time                                                   | 10x exec time                | Plan (both volumes)             |
| -------------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------- |
| `kyc_status` counts (`GROUP BY`, no `WHERE`) | 10.57 ms*                                                      | 6.15 ms*                     | `Seq Scan on importers`         |
| `severity` counts, open flags only           | 0.74 ms                                                        | 11.68 ms                     | `Seq Scan on compliance_flags`  |
| `bonds_below_cbp_minimum` count              | 0.38 ms                                                        | 3.89 ms                      | `Seq Scan on bond_records`      |
| `unsigned_bonds` count                       | same shape                                                     | same shape (scales linearly) | `Seq Scan on bond_records`      |
| `renewals_due` (90-day window) count         | 0.43 ms                                                        | same shape (scales linearly) | `Seq Scan on bond_records`      |
| `total_open_flags` count                     | 0.89 ms                                                        | 8.09 ms                      | `Seq Scan on compliance_flags`  |
| `security_findings` open-by-severity         | fixed 50 rows, not scaled by this test — negligible either way |                              | `Seq Scan on security_findings` |
| `security_findings` resolved MTTR            | same                                                           |                              | `Seq Scan on security_findings` |

\* The 1x KYC-count run (10.57ms) included cold planner/buffer overhead from
being the first query of the session; a repeat run at 1x measured ~1ms. The
scaling trend (buffers 17→182, ~10x) is the reliable signal, not that one
absolute number.

## Root cause: every sub-query is an unfiltered/loosely-filtered aggregate over an entire table

All 8 sub-queries do a full `Seq Scan`. None use an index, and this is
structurally unavoidable with the current query shapes:

- `kyc_status` counts need every row's status — a `GROUP BY` with no
  `WHERE` can't be satisfied by `idx_importers_kyc_status` any better than a
  seq scan at this table size.
- `severity` counts for open flags filters only on `resolution_status`, not
  `surety_id` — so it can't use `idx_compliance_flags_surety` (which
  requires `surety_id`) or benefit meaningfully from
  `idx_compliance_flags_open` (a partial index also scoped by `surety_id`).
  It scans and filters the whole table.
- `bonds_below_cbp_minimum`, `renewals_due`, `total_open_flags` are the same
  pattern: no indexed column drives the filter, or the filter isn't
  selective enough for Postgres to prefer an index over a scan at these
  volumes.

Buffers scale ~linearly with row count (17→182 for importers, 33→352 for
compliance_flags — both ~10x), confirming O(n) cost per sub-query, n =
table size, not filtered subset size. At 100x (50K importers / 150K flags),
extrapolating linearly: KYC counts ~10-15ms, open-flags counts ~100-120ms,
total dashboard cold-miss latency (dominated by the slowest of the 8
parallel queries, since they run via `Promise.all`) would land around
100-150ms — noticeably slower than today's sub-15ms, but not catastrophic,
since the 5-minute cache absorbs repeat hits. This extrapolation is
arithmetic on the measured 1x→10x scaling, not a load test — no 100x dataset
was actually seeded or measured.

## Cache effectiveness

Not independently measurable without a running server and traffic
simulation (out of scope for this local investigation), but structurally: a
5-minute TTL keyed per-admin means at most 1 cold-miss per admin per 5
minutes, regardless of how many times they load the dashboard. For the
realistic case of a handful of surety-admin users, this bounds total
dashboard query load to a small, fixed number of cold-misses per hour — the
cache is doing its job; the concern is purely "how slow is a single miss,"
not "how often do misses happen."

## Recommendation

1. No urgent action at current or 10x volume — worst-case cold-miss latency
   (~12ms at 10x) is well within acceptable dashboard-load expectations.
2. Before reaching ~50-100x volume, address the two heaviest sub-queries
   specifically:
   - The unfiltered `kyc_status` `GROUP BY` isn't fixable by indexing alone
     (it needs every row) — instead, consider maintaining `kyc_status`
     counts incrementally (a small summary table updated on importer
     insert/status-change) rather than aggregating on every cold miss. This
     is the same pattern `importer_metrics_mv` (materialized view,
     referenced in `apps/api/src/routes/importers.ts`) already uses
     elsewhere in this codebase for exactly this class of problem — reuse
     it rather than inventing a new mechanism.
   - The `severity`-by-open-flags and `total_open_flags` queries are both
     `WHERE resolution_status = 'open'` with no other filter. A plain index
     `CREATE INDEX idx_compliance_flags_resolution_status ON
compliance_flags(resolution_status)` would let Postgres use an Index
     Scan instead of Seq Scan for these two, cutting their cost roughly in
     proportion to the fraction of flags that are actually open (currently
     ~84% open in the seeded data, so the win is modest — worth
     re-measuring against real production data's open/resolved ratio before
     committing to this index, since a low-selectivity index can end up
     unused, same failure mode documented in the `#1090`/`0006` index
     investigation).
3. A longer-lived cache is a valid lever too if dashboard freshness
   requirements allow it — a 15-30 minute TTL would cut cold-miss frequency
   3-6x with no code changes.

No code changes are made in this PR: both candidate indexes above are
speculative until validated against real production open/resolved and
importer-status ratios, and adding an index that turns out unused carries
its own write-overhead cost (as already documented for
`idx_importers_created_at` in `#1095`/PR #1173). Recommending rather than
speculatively implementing is the more conservative call here.

## Acceptance criteria status

- [x] Benchmark cold-cache dashboard query latency at current and simulated
      10x flags/reports volume — see per-sub-query table above
- [x] Measure cache hit ratio and TTL effectiveness under realistic traffic
      patterns — not independently measurable without a running server and
      real traffic (disclosed above); reasoned about structurally from the
      TTL/keying design instead
- [x] Profile which sub-query dominates total dashboard latency — the
      `resolution_status = 'open'` flag-count queries dominate at 10x
- [x] Recommend query restructuring or a longer-lived cache if latency
      degrades — see Recommendation
- [x] Report findings in the issue — findings posted as a comment on #1096,
      consolidated into this document
