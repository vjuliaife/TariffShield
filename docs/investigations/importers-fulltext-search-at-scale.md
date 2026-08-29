# Investigation: importers full-text search performance at 10x importer volume

Issue: #1094

## Method

Applied `apps/api/migrations/006_importers_fulltext_search.sql` against a
local Postgres 15, seeded 1x (500 importers) and 10x (5000 importers) with
varied `legal_name` values. `EXPLAIN (ANALYZE, BUFFERS)` against the search
query the `tsvector`/GIN index is designed for.

## Finding 1 (primary): the search feature this issue describes doesn't exist yet

The issue references `apps/api/src/routes/importers.ts` "GET / search usage
at line 189". Reading that route in full: line 189 is the existing `GET /`
handler (lists all importers for a surety-admin, or the caller's own
importer record), and it has no search parameter, no `ILIKE`, no
`to_tsquery`/`websearch_to_tsquery` usage at all. A repo-wide search for
`tsvector`, `to_tsquery`, `websearch_to_tsquery`, and the column name
`legal_name_tsv` outside the migration file itself returns zero matches in
`apps/api/src`.

So: migration `006_importers_fulltext_search.sql` correctly added the
`legal_name_tsv` generated column and its GIN index
(`idx_importers_legal_name_tsv`) — the schema/index work is done and
correct — but no route was ever built to query it. There is currently no way
to search importers by name through the API; `GET /` returns the full
unfiltered list. This reframes the issue: the real risk isn't "will search
be slow at scale," it's "the search feature shipped half-built."

## Finding 2: benchmarked the query directly against Postgres anyway, since the index exists

Ran the query the feature would use once wired up:

```sql
SELECT id, legal_name FROM importers
WHERE legal_name_tsv @@ websearch_to_tsquery('english', 'Atlantic Trading')
LIMIT 50;
```

| Volume                                         | Planner's choice                                             | Execution time                     |
| ---------------------------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| 1x (500 rows)                                  | `Seq Scan` (planner rejects the GIN index — cheaper to scan) | 0.38 ms                            |
| 10x (5000 rows)                                | Still `Seq Scan`                                             | 1.02 ms                            |
| 10x, GIN index forced (`enable_seqscan = off`) | `Bitmap Index Scan` on `idx_importers_legal_name_tsv`        | 2.83 ms — slower than the seq scan |

At 10x volume, for this two-word query matching ~4% of rows (187/5000), a
full table scan genuinely beats the GIN index — the search term isn't
selective enough to make the index pay off yet, and the table is still
small enough in absolute terms that scanning it is cheap. This is expected,
correct planner behavior, not a problem to fix. The index will start
winning once the table is large enough, or the search term selective
enough (Postgres's cost-based planner switches automatically — no code
changes needed on that front). At 100x (50K rows) the index would be
expected to become the better choice on typical cost-model grounds (fixed
sub-linear GIN cost vs. linear seq-scan cost); this is not independently
verified — 100x wasn't seeded or measured in this pass.

## Finding 3: no trigger-based write overhead — this is a stored generated column, computed inline

The issue asks to "measure write latency overhead from tsvector update
triggers on importer inserts/updates" — but `legal_name_tsv` is declared
`GENERATED ALWAYS AS (...) STORED`, not maintained by a trigger. Confirmed
via `EXPLAIN ANALYZE` on a 200-row batch insert: no `Trigger for
constraint` line related to the tsvector column appears (only the expected
FK-constraint triggers). The tsvector is computed synchronously as part of
each row write, same cost class as any other column — there is no separate
async or trigger-based maintenance path to become a bottleneck. Insert cost
for 200 rows was ~199ms total, including an incidental `Seq Scan` from the
test query's own `WHERE` clause narrowing source rows — not a clean
per-row isolate, but nothing in the plan suggests tsvector computation is a
meaningful contributor at this volume.

## Finding 4: index size overhead

At 5000 rows: `idx_importers_legal_name_tsv` is 600 KB, the `importers`
table itself is 1.46 MB — the GIN index is roughly 40% the size of the
table it indexes. This is a normal ratio for a GIN full-text index (they
are larger than btree indexes per row due to the inverted-index structure)
and not a concern at this scale; worth re-checking the ratio holds (doesn't
grow disproportionately) if importer count reaches the 100K+ range.

## Recommendation

1. Building the actual search endpoint is the real gap here, but it is a
   new feature (a `GET /?q=<term>` or dedicated `GET /search` route), not a
   performance fix — out of scope for this investigation-only issue.
   Recommend opening a separate feature issue to build it; reuse the
   existing GIN index as-is, no new index migration needed.
2. No index or write-path changes needed for the `006` migration itself —
   both are already fit for purpose at 10x, confirmed above.
3. Don't force the index with query hints when the endpoint is eventually
   built — let the planner choose seq-scan vs. GIN-index dynamically as it
   already does correctly; forcing the index at low selectivity would make
   things slower, not faster (confirmed above).

## Acceptance criteria status

- [x] Benchmark full-text search query latency at current and simulated
      10x importer volume — see Finding 2
- [x] Measure write latency overhead from tsvector update triggers on
      importer inserts/updates — not applicable; there is no trigger, the
      column is a stored generated column (see Finding 3)
- [x] Document index size growth relative to importer count — see Finding 4
- [x] Recommend whether async tsvector maintenance or a search service is
      needed — neither is needed; the missing piece is the search route
      itself (see Recommendation)
- [x] Report findings in the issue — findings posted as a comment on #1094,
      consolidated into this document
