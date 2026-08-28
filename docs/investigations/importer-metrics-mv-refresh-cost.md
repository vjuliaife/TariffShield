# Investigation: `importer_metrics` materialized view refresh cost at scale

Issue: #1091

## Summary

`/admin/importers/metrics` (`apps/api/src/routes/importers.ts:346-360`) and
`/importers/:id/metrics` (`importers.ts:367-387`) both read from the
`importer_metrics` materialized view (defined in
`apps/api/src/migrations/0001_initial_schema.ts:467-497`, re-created
identically post-partitioning in
`0002_partition_contract_events.ts:183-213`). This is a different view from
the similarly-named `importer_metrics_mv` singleton dashboard-stats view
(#251) — the two are refreshed by two different functions in `db.ts` and
this issue is about `importer_metrics` specifically, the per-importer one.

## Is `REFRESH ... CONCURRENTLY` used?

Yes. `refreshImporterMetricsView()` (`apps/api/src/db.ts:953-959`) runs
`REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics`, and the view has
the required unique index for that
(`idx_importer_metrics_importer_id`, `0001_initial_schema.ts:496-497`). So
concurrent _readers_ are never blocked by a refresh — that AC question has
a definite, code-verified answer.

## What CONCURRENTLY doesn't fix: refresh cost scales with total system volume

The view definition (`0001_initial_schema.ts:467-491`) aggregates across
**every** importer, with a `LEFT JOIN contract_events ce ON ce.importer_id =
i.id` and a `SUM(...) FILTER` over that importer's full event history, for
every row. A `REFRESH` — concurrent or not — has to recompute the entire
view, i.e. do that full join/aggregate over all importers × all bonds × all
contract_events, every time it runs.

`refreshImporterMetricsView()` is called from exactly one place:
`POST /importers/:id/upload-tariff-csv`
(`importers.ts`, previously line 721, now inside the try/catch at
~line 730), synchronously awaited on every single tariff-CSV upload from
any importer. That means:

- The cost of one importer's upload scales with **total** bond/collateral
  volume across the whole system, not their own data — exactly what this
  issue's AC asks about ("as underlying bond/collateral row counts grow").
- At 10x volume, this refresh takes proportionally longer, all of it spent
  synchronously inside the HTTP request for an action (uploading a tariff
  CSV) that has nothing to do with the other importers whose data is being
  re-aggregated.
- Before this investigation's fix, that `await` had no `try`/`catch`
  around it: a slow refresh that happened to time out or fail (lock wait,
  connection pool exhaustion, whatever) would throw past the point where
  the on-chain collateral update and `tariff_uploads` row had **already
  succeeded**, turning a successful upload into a client-visible `500`.
  Every other non-critical side effect in this same handler (friendbot
  funding in `POST /`, `evaluateTariffAlerts` two lines above) is
  deliberately wrapped for exactly this reason; the refresh call was the
  one exception.

## Fix applied

`importers.ts`: wrapped `await refreshImporterMetricsView()` in its own
`try`/`catch`, matching the adjacent `evaluateTariffAlerts` pattern and its
documented rationale. This doesn't change the refresh's cost or timing (it
is still awaited synchronously, so the staleness-window guarantee in
`refreshImporterMetricsView`'s doc comment — refresh completes before the
response is sent — is preserved), it only stops a slow/failed refresh from
turning an otherwise-successful upload into a `500`.

## What wasn't changed, and why

Removing the `await` (fire-and-forget) or dropping the on-demand call
entirely in favor of only the documented periodic-refresh cadence would
better address the _latency_ half of this issue (an upload response no
longer waits on a system-wide aggregate), but both are staleness/product
tradeoffs already made deliberately, per the doc comment on
`refreshImporterMetricsView`:

> Near-zero latency for tariff upload mutations since refresh is triggered
> immediately. Up to 5 minutes latency... for on-chain events if relying
> on periodic refresh.

Changing that tradeoff isn't a "fix a bug" change, it's a product decision
about acceptable staleness — out of scope for a minimum fix here, and left
as the concrete recommendation below instead.

## Recommendation

If refresh latency becomes a measured problem at real 10x volume:
incremental/partial refresh isn't available for materialized views in
Postgres (a `REFRESH` always recomputes the full definition), so the
options are (a) make the on-demand call fire-and-forget instead of awaited,
accepting a small staleness window on the upload response itself, or (b)
drop the on-demand refresh and rely solely on the periodic job, accepting
the documented up-to-5-minute staleness for tariff-upload-triggered changes
too. Either requires deciding how stale `/importers/:id/metrics` is allowed
to be immediately after an upload — a product call, not a technical one.

## Reproducing / measuring

No live Postgres instance was available in this environment to benchmark
actual `REFRESH` duration at simulated 10x bond/collateral volume or to
observe lock behavior against concurrent readers directly. The
`CONCURRENTLY`-avoids-reader-blocking conclusion is verified by reading the
migration and `db.ts` (not by observing it); the refresh-cost-scales-with-
total-volume conclusion follows from the view's own `LEFT JOIN`/aggregate
definition, not from a captured timing number.

## Acceptance criteria status

- [ ] Benchmark refresh duration at current volume and at simulated 10x
      volume — not possible without a live DB in this environment
- [ ] Measure lock contention against concurrent reads during refresh —
      same limitation; `CONCURRENTLY` is confirmed in use by code
      inspection, which by definition avoids exclusive-locking readers
- [x] Document whether CONCURRENTLY refresh is used and its impact — yes,
      confirmed (`db.ts:953-959`); it protects concurrent _readers_, not
      the refresh-triggering request's own latency or error handling
- [x] Recommend refresh cadence or incremental-refresh alternative if
      needed — see Recommendation above; incremental refresh isn't
      available for materialized views in Postgres, so the real choice is
      fire-and-forget vs. periodic-only, both staleness tradeoffs
- [x] Report findings in the issue — this document
