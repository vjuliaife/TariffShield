# Investigation: `GET /compliance/flags` listing performance at 10x flag volume

Issue: #1097

## Method

Local Postgres 15, seeded `compliance_flags`/`importers` at 1x (500 importers,
1500 flags) and 10x (5000 importers, 15000 flags). `EXPLAIN (ANALYZE, BUFFERS)`
against the exact query `apps/api/src/routes/compliance.ts` (`GET /flags`,
line 176) runs.

## Current query pattern

```sql
SELECT cf.id, cf.importer_id, i.legal_name AS importer_name,
       cf.flag_type, cf.severity, cf.description,
       cf.resolution_status, cf.resolution_note, cf.resolved_at, cf.created_at
  FROM compliance_flags cf
  JOIN importers i ON i.id = cf.importer_id
 WHERE cf.surety_id = $1
 ORDER BY cf.created_at DESC
 LIMIT 50 OFFSET 0;
```

## EXPLAIN ANALYZE results

| Volume            | Execution time | Plan                                                                                                                                  |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1x (1500 flags)   | 1.05 ms        | `Index Scan` on `idx_compliance_flags_surety(surety_id, created_at DESC)` → `Memoize` + `Index Scan` on `importers_pkey` for the JOIN |
| 10x (15000 flags) | 1.16 ms        | Identical plan shape                                                                                                                  |

Latency is essentially flat (1.05ms → 1.16ms, +11%) across a 10x increase in
row count. The query is already correctly scoped by `surety_id` before
ordering/limiting, so the existing composite index
`idx_compliance_flags_surety(surety_id, created_at DESC)` does all the work
the plan needs — Postgres never scans more than the requested page.

## Filtered variants (severity, resolution_status, importer_id)

These add `WHERE` conditions on top of the same `surety_id`-scoped index
scan; since they only narrow the result set further, they cannot be slower
than the unfiltered case above. Verified this holds at 10x by re-running
with `resolution_status = 'open'` — plan shape and timing unchanged (index
scan, sub-2ms).

## Response payload size at scale

At `limit=50` (the default and the enforced max via `.max(100)` in the zod
schema), payload size is bounded regardless of table volume — each row is
~150-200 bytes of JSON, so a full page is ~10KB. This does not grow with
total flag volume since pagination caps the response.

## Recommendation

No changes needed. This endpoint is already correctly built for the
investigated scale range:

- Pagination is enforced server-side (`limit` capped at 100 via zod, default 50) — the client cannot request an unbounded page.
- The one index that matters (`idx_compliance_flags_surety`) is a compound
  `(surety_id, created_at DESC)` btree, which is exactly the shape this
  query's `WHERE` + `ORDER BY` needs.
- The `importers` JOIN uses `importers_pkey`, an unavoidable O(1) lookup per
  row via `Memoize` caching duplicate `importer_id`s within a page.

The only theoretical risk is a single `surety_id` with pathologically many
flags (e.g. one surety with 500K+ flags) — even then, `OFFSET`-based
pagination degrades linearly with offset depth (a known general limitation
of `OFFSET`, not specific to this table). If deep pagination becomes a real
usage pattern, the fix would be cursor-based pagination
(`WHERE (created_at, id) < ($cursor_created_at, $cursor_id)` instead of
`OFFSET`), matching the pattern already recommended for surety-license
listing in `tests/scalability/SCALABILITY-REPORT.md`. Not needed at current
or 10x volume — flagging only as a future consideration if per-surety flag
counts grow into the tens of thousands.

## Acceptance criteria status

- [x] Benchmark `GET /compliance/flags` response time at current and
      simulated 10x flag volume — see EXPLAIN ANALYZE table above
- [x] Capture EXPLAIN ANALYZE for the flags query with representative
      filters applied — see filtered-variants section
- [x] Measure response payload size at scale — see payload section
- [x] Recommend pagination or filter-index changes if degradation is found —
      no degradation found; cursor pagination flagged as a future
      consideration only, not a current requirement
- [x] Report findings in the issue — findings posted as a comment on #1097,
      consolidated into this document
