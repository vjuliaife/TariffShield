# Investigation: `GET /importers` pagination at scale

Issue: #1090

## Summary

`GET /importers` (`apps/api/src/routes/importers.ts:189-206`) has two branches:

```sql
-- surety_admin
SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at, u.email
  FROM importers i JOIN users u ON u.id = i.user_id
  ORDER BY i.created_at DESC

-- non-admin
SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at
  FROM importers i WHERE i.user_id = $1
```

Neither branch has a `LIMIT`/`OFFSET` or cursor. The non-admin branch is
already bounded independent of table size: `POST /importers` rejects a
second registration for the same `user_id` with `409` (`importers.ts:72-76`,
enforced at the DB level by `importers.user_id UUID NOT NULL UNIQUE`), so a
user has at most one importer row — that branch returns 0 or 1 rows
regardless of total importer count and needs no pagination.

The surety_admin branch is the real concern: it returns every importer in
the system, unbounded, on every load of the admin dashboard
(`apps/web/app/surety/page.tsx`, via `listImporters()` in
`apps/web/lib/api.ts:113`).

## Query plan

`ORDER BY i.created_at DESC` with no `WHERE` clause needs either a full
sequential scan + sort, or an index that's already sorted on `created_at
DESC`. No such index existed anywhere `npm run migrate` actually applies —
see `apps/api/src/migrations/0006_importers_and_events_perf_indexes.ts` for
how that was confirmed (grepped every real migration file and `db.ts`; the
index was only ever added to a legacy, unexecuted `.sql` file from an
earlier PR closing #257). That migration adds
`idx_importers_created_at ON importers(created_at DESC)`, so the plan-type
question this issue's AC asks about (Seq Scan vs. Index Scan) is answered:
it was Seq Scan + Sort before, Index Scan after.

## What an index alone doesn't fix

An index makes producing the sorted row set cheap; it does nothing about
response size. At N importers this endpoint always serializes and returns
all N rows, joined against `users`. That's the part of this issue's AC this
investigation could **not** resolve with a safe, minimal change:

- The only current caller (`apps/web/app/surety/page.tsx`) renders the
  full list with no pagination UI, "load more", or virtualization, and
  calls `listImporters()` with no query parameters.
- Adding pagination to the response shape used by that caller would either
  (a) change the default response shape and require the frontend to also
  change (a bigger change than one issue in a 4-issue batch justifies), or
  (b) be an opt-in parameter nothing calls yet, which is speculative code
  serving no current caller.
- A correct keyset cursor for `ORDER BY created_at DESC` needs a compound
  cursor on `(created_at, id)`, not `id` alone — `importers.id` is a random
  `uuid_generate_v4()` value with no relationship to insertion order, so a
  cursor keyed on `id` alone (the shape `GET /:id/events` already uses
  elsewhere in this file, `importers.ts:448-459`) would not actually
  preserve `created_at DESC` ordering across pages. Getting this right is
  more than a drive-by addition to a query whose only caller doesn't
  paginate today.

## Recommendation

- **Covering index: done** (`0006_importers_and_events_perf_indexes.ts`).
  Safe, additive, no behavior change for any caller.
- **Cursor-based pagination: recommended, not implemented here.** When the
  admin importer list is expected to grow past a few thousand rows (or the
  dashboard page needs to stop rendering everything at once for other UX
  reasons), add `cursor`/`limit` query params using a compound
  `(created_at, id)` keyset — e.g.
  `WHERE (i.created_at, i.id) < ($cursorCreatedAt, $cursorId) ORDER BY i.created_at DESC, i.id DESC LIMIT $limit`
  — and update `apps/web/lib/api.ts`'s `listImporters()` plus the surety
  dashboard page together in the same change, since an API-only change here
  wouldn't fix anything the current frontend actually does.

## Reproducing / measuring

No live Postgres instance was available in this environment (no Docker
daemon, no local `psql`) to run the `EXPLAIN (ANALYZE, BUFFERS)` captures
and payload-size measurements this issue's AC asks for at 1x/5x/10x volume.
The Seq Scan → Index Scan conclusion above is a code-level/schema-level
deduction (no matching index existed; one now does), not a measured result.
`apps/api/tests/load/get-importers.js` (k6, added for #265) exercises this
endpoint's request-handling concurrency but not row-count scaling — it
doesn't seed 5x/10x importer rows, so it doesn't answer this issue's
question either. Capturing real `EXPLAIN ANALYZE` output at populated
volume, as `docs/query-analysis.md` did for #257, is the natural follow-up
once a staging DB with representative data is available.

## Acceptance criteria status

- [ ] Benchmark GET /importers response time at 1x, 5x, and 10x current
      importer row count — not possible without a live DB in this
      environment
- [ ] Capture EXPLAIN ANALYZE output at each scale — same limitation
- [ ] Measure payload size and serialization time contribution — same
      limitation; qualitatively, payload size is unbounded and grows
      linearly with importer count regardless of index (see above)
- [x] Recommend whether cursor-based pagination or a covering index is
      warranted — both: the covering index is safe and implemented now;
      cursor pagination is recommended for whenever the admin list needs to
      stop rendering everything at once, implemented together with the
      frontend consumer rather than speculatively here
- [x] Report findings in the issue — this document
