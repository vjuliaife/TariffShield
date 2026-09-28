# RFC 0960: Rename `indexer.ts` to `indexer-lag-monitor.ts` and align exported symbols

- Status: Proposed
- Issue: #960

## Summary

`apps/api/src/indexer.ts` is named and documented as if it drives contract-event ingestion, but
its only runtime behaviour is computing a Prometheus lag gauge and emitting threshold-based
structured logs. Actual event persistence lives in
`apps/api/src/services/oracle-event-listener.ts`. Rename the module to `indexer-lag-monitor.ts`,
update its exported symbol names to match, and add a one-sentence note to
`docs/architecture` (or `ARCHITECTURE.md`) pointing future contributors to
`oracle-event-listener.ts` for the real ingestion path.

---

## 1. What `indexer.ts` actually does

| Export | What it really does |
|---|---|
| `startIndexer()` | Sets a 30-second `setInterval` that calls `checkLagAndIndex()`. Does **not** fetch or persist any contract events. |
| `stopIndexer()` | Clears that interval. |
| `indexerLagGauge` | Prometheus `Gauge` named `contract_event_indexer_lag_ledgers`. Set by `checkLagAndIndex`. |
| `logger` | A module-level Pino logger re-exported for use elsewhere. |
| `checkLagAndIndex()` (private) | Reads `getCurrentLedgerSequence()` and `getLastProcessedLedger()`, computes their difference, sets the gauge, emits a Pino log at debug/warn/error depending on threshold, then calls `updateLastProcessedLedger(currentLedger)` to advance the watermark. |

The name `checkLagAndIndex` is itself misleading — step 5 (advancing the watermark) is not
indexing; it just acknowledges the ledger has been _observed_. No contract events are fetched
or written to the database.

**Where actual indexing happens:** `apps/api/src/services/oracle-event-listener.ts` polls
`rpc.getEvents()` and persists the results. That module is the true indexer.

---

## 2. Proposed rename

| Before | After |
|---|---|
| `apps/api/src/indexer.ts` | `apps/api/src/indexer-lag-monitor.ts` |
| `startIndexer` | `startLagMonitor` |
| `stopIndexer` | `stopLagMonitor` |
| `logger` (re-export) | unchanged — keep name, but consumers should import from a shared logger module |
| `indexerLagGauge` | unchanged — the Prometheus metric name `contract_event_indexer_lag_ledgers` is already public/scraped; renaming the TS variable alone is low-impact |

The Prometheus metric name itself (`contract_event_indexer_lag_ledgers`) references "indexer"
because it describes what the gauge measures (lag behind the indexer watermark). Changing it
would require updating any Grafana dashboards or Alertmanager rules that reference it.
**Recommendation:** leave the metric name unchanged for now; add a `# HELP` comment in the
gauge definition clarifying it measures watermark lag, not ingestion throughput.

---

## 3. Import sites affected

| File | Current reference | Change needed |
|---|---|---|
| `apps/api/src/index.ts:19` | `import { startIndexer } from './indexer.js'` | → `import { startLagMonitor } from './indexer-lag-monitor.js'`; update call on line that calls `startIndexer()` |
| `apps/api/src/db.ts` | Not imported — only defines `indexer_state` table helpers (`getLastProcessedLedger`, `updateLastProcessedLedger`). Table name `indexer_state` is a DB identifier, not a TS symbol; no rename needed. | No change |

There are no test files that `import` from `indexer.ts` directly (the reconnect tests in
`lib/soroban/reconnect.test.ts` are unrelated). Confirm with:

```bash
grep -r "from.*indexer" apps/api/src --include="*.ts"
```

Monitoring config (Prometheus scrape config, Grafana dashboards) references the metric name
`contract_event_indexer_lag_ledgers`, not the TypeScript module path — those are unaffected by
the file rename.

---

## 4. Interaction with the oracle-event-listener / oracle-monitor consolidation RFC

Issue #962 proposes consolidating `oracle-event-listener.ts` and the lag-monitoring
responsibility. If that RFC is accepted, `indexer-lag-monitor.ts` may be absorbed entirely into
the unified oracle module. This rename should therefore be treated as an interim step:

- If #962 proceeds: keep the renamed file as a thin re-export shim during the migration, then
  delete it once the oracle module owns lag monitoring.
- If #962 is deferred: the rename stands on its own and gives contributors accurate signal about
  where to look when debugging missing events.

In either case, landing this RFC first does not block #962 and makes the #962 scope clearer
(it's consolidating _lag monitoring_ into the oracle module, not a real indexer).

---

## 5. Trade-offs

| | Rename | Keep current name |
|---|---|---|
| **Onboarding clarity** | New contributors read "lag monitor" and go to `oracle-event-listener.ts` for ingestion debugging | Likely to cause confusion: contributors spend time reading `indexer.ts` looking for event fetch logic that isn't there |
| **Import churn** | One import site in `index.ts`, zero test files | No churn |
| **Metrics dashboard impact** | None (metric name unchanged) | N/A |
| **Historical git context** | `git log` on the old path stops at rename; `git log --follow` still works | N/A |
| **Scope if #962 lands** | Shim deleted when oracle module absorbs lag monitoring | File accumulates both names' confusion |

**Verdict:** rename. The single import site makes this a near-zero-risk change, and the
naming confusion is already causing contributors to look in the wrong place when debugging event
ingestion lag.

---

## 6. Architecture note (to be added to `ARCHITECTURE.md` or `docs/architecture`)

Suggested addition under the existing _Event ingestion_ section:

> `apps/api/src/indexer-lag-monitor.ts` tracks how far behind the last-processed ledger
> watermark is relative to the chain tip and exposes this as the Prometheus gauge
> `contract_event_indexer_lag_ledgers`. It does **not** fetch or persist contract events —
> that is the responsibility of `apps/api/src/services/oracle-event-listener.ts`.
