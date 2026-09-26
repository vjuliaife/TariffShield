# RFC 0954: One oracle ingestion loop; retire `oracle-monitor.ts`

- Status: Proposed
- Issue: #954

## Summary

**Consolidate.** The two services do overlap on the same contract event stream,
so the issue's instinct is right. But the audit found something the issue did
not anticipate: `oracle-monitor.ts` **matches zero events and has never inserted
a row into `oracle_alerts`**. Its topic filter cannot match the contract's event
layout, and if it did, it would insert a non-UUID that violates a foreign key.

So the payoff is not "halve the RPC load" (it is real but small — two calls per
10s). It is that oracle alerting is currently non-functional, and the
consolidation is the smallest way to make it real: one poll loop, one
checkpoint, one parsed event, two independent consumers of the parsed result.

## 1. Audit: what each service actually does

### 1.1 `oracle-event-listener.ts` (316 lines) — works

Polls Soroban RPC every **12 000 ms** (`POLL_INTERVAL_MS`, line 40) and
persists `set_required_collateral` events into `oracle_price_feed`.

- **Checkpoint:** yes. `STATE_KEY = 'oracle_event_listener'` (line 37) in the
  `listener_state` table, read by `getListenerState()` (66-72) and written by
  `setListenerState()` (74-83).
- **Window:** from `checkpoint + 1` to `min(latest, from + 200)`
  (`MAX_LEDGER_WINDOW`, line 43), `limit: 200` (line 240). First run with no
  checkpoint looks back 720 ledgers (~1 hour, `INITIAL_LOOKBACK_LEDGERS`, line
  46).
- **Filter (lines 232-238):** two alternatives —
  `['required', '*']` and `['EmergencyOracleUpdate', '*']`.
- **Idempotent:** `ON CONFLICT (tx_hash, importer_address) DO NOTHING` (line
  179), backed by the unique index `idx_oracle_price_feed_tx_importer`
  (`db.ts:760-761`).
- **Runs immediately on start** (lines 292-298) before entering the interval, so
  downtime is replayed at boot.
- **Tested:** `services/oracle-event-listener.test.ts` exercises
  `pollOracleEvents` and `getListenerState` (imports at lines 62-64, assertions
  at 158-266).

### 1.2 `oracle-monitor.ts` (106 lines) — does not work

Polls Soroban RPC every **10 000 ms** (line 60).

- **Checkpoint: none.** There is no `listener_state` access in this file.
  `startLedger` is recomputed as `currentLedger.sequence - 100` every cycle
  (line 19), commented `// Look back a bit just for demo`.
- **Filter (line 27):** `[['*', 'required', '*', '*']]`.
- **No immediate first poll** — unlike the listener, the first cycle is up to
  10 s after boot.
- **No tests.** No `oracle-monitor.test.ts` exists.
- Its only external export, `processOracleEvent` (line 70), is called from
  exactly one place: line 52, inside its own loop.

### 1.3 Do they poll the same event range redundantly? — Partly. The premise needs correcting.

The issue states both services run "their own poll loop against the same
contract event stream, doubling RPC load **and checkpoint bookkeeping
(`listener_state`)**". First half right, second half wrong:

- **RPC load is genuinely duplicated.** Both call `createRpcServer(env.STELLAR_RPC_URL)`
  (`oracle-monitor.ts:14`, `oracle-event-listener.ts:290`) against the same
  `env.TARIFF_SHIELD_CONTRACT_ID`, and both run continuously from the same boot
  sequence (`index.ts:387-388`). Two `getLatestLedger()` + two `getEvents()` per
  cycle.
- **`listener_state` bookkeeping is not duplicated.** Only the listener reads or
  writes it. There is exactly one `STATE_KEY` in the codebase. There is no
  second checkpoint to consolidate.
- **The redundancy is worse than "two loops over the same range", and also
  smaller.** The monitor re-scans a fixed trailing 100 ledgers every 10 s and
  does nothing with the result, so its RPC cost buys nothing. The listener
  scans each ledger range exactly once. In RPC-call terms the monitor is the
  larger share of the waste; in *data* terms the listener is the only consumer.

### 1.4 Why the monitor matches nothing — root cause

The contract publishes exactly two topics (event name, importer address):

```rust
// contracts/tariff-shield/src/lib.rs:513-522
if emergency {
    env.events().publish(
        (Symbol::new(&env, "EmergencyOracleUpdate"), importer.clone()),
        (old_required, adjusted_required, current_timestamp, caller),
    );
} else {
    env.events().publish(
        (symbol_short!("required"), importer.clone()),
        (old_required, adjusted_required),
    );
}
```

Compare with the two filters:

| | topic positions | `required` position | matches? |
| --- | --- | --- | --- |
| contract emits | 2 | 0 | — |
| listener filter (`oracle-event-listener.ts:232-238`) | 2 | 0 | **yes** |
| monitor filter (`oracle-monitor.ts:27`) | 4 | 1 | **no** |

The monitor's filter demands a 4-element topic vector with `required` at index
1. The contract emits a 2-element vector with `required` at index 0. A topic
filter is positional, so this returns an empty event set on every cycle. The
`for` loop at line 33 never executes, `processOracleEvent` (line 52) is never
called, and `oracle_alerts` is never written.

The listener's `parseOracleEvent` (102-149) reads `topics[0]` as the symbol and
`topics[1]` as the importer address, which is the correct reading of the
contract — further confirmation that the listener matches the contract and the
monitor does not.

### 1.5 Three further reasons the monitor could not alert even if the filter matched

These matter for the migration plan, because fixing only the filter would
produce a service that fails loudly instead of silently.

1. **The values are hardcoded mocks.** Lines 48-50:

   ```ts
   const oldVal = 1000;
   const newVal = 2000;
   const importerId = 'mock-importer';
   ```

   The surrounding comments are candid about it — line 43: *"We'll mock the
   extraction"*; line 47: *"Actually, we'll just mock the parsing here for the
   sake of the exercise."* Line 44 even notes *"the API routes actually insert
   `contract_events` into the DB"* and line 45 suggests monitoring that table
   instead. Every event would be evaluated as a 100% change against
   `'mock-importer'`.
2. **The FK would reject the insert.** `oracle_alerts.importer_id` is
   `UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE` (`db.ts:313-322`).
   `'mock-importer'` is not a UUID, so the insert at line 89-93 would raise
   `22P02`/`23503` on every event.
3. **No deduplication.** Unlike `oracle_price_feed`, `oracle_alerts` has **no
   unique index** — `grep oracle_alerts db.ts` returns only the `CREATE TABLE`.
   With a fixed 100-ledger re-scan every 10 s, a corrected monitor would insert
   a duplicate alert for the same `tx_hash` on every cycle, forever. The
   listener's equivalent is safe precisely because of the unique index plus
   `ON CONFLICT DO NOTHING`.

### 1.6 A fourth, separate finding: `pct_change` is computed two different ways

| | formula | sign | store |
| --- | --- | --- | --- |
| listener (169-172) | `Number(((new - old) * 10000n) / old) / 100` | signed (bigint, truncating) | `pctChange.toFixed(4)` → `NUMERIC(7,4)`, percent |
| monitor (80) | `Math.abs(newVal - oldVal) / oldVal` | absolute (float) | `pctChange * 100` → `NUMERIC(5,2)`, percent |

Both store a percentage, but the listener's is signed and truncated in bigint
arithmetic while the monitor's is an absolute float. Alerting on `pct_change`
needs one definition. Consolidation should pick the listener's (it has
`previous_collateral` and `required_collateral` columns to be consistent with,
and it does not lose a small-but-real decrease to `Math.abs`).

### 1.7 Both stop functions are dead

`stopOracleMonitor` (line 63) and `stopOracleEventListener`
(`oracle-event-listener.ts:310`) are exported and called from nowhere. There is
no SIGTERM handler in `index.ts:381-415`, so a rolling deploy abandons in-flight
polls. Low severity, but it belongs in the consolidated service's lifecycle.

## 2. Proposal: one ingestion service, one loop, two concerns

`oracle-event-listener.ts` already has the correct filter, the checkpoint, the
idempotency and the tests. So consolidation means **extending it, not merging
two equals** — the monitor contributes nothing except a broken filter and a
threshold comparison that can be lifted almost verbatim.

```ts
// apps/api/src/services/oracle-ingestion.ts

export interface OracleIngestionOptions {
  pollIntervalMs?: number;   // default 12_000
  maxLedgerWindow?: number;  // default 200
  alertThresholdPct?: number;// default env.ORACLE_ALERT_THRESHOLD_PCT ?? 50
}

export async function startOracleIngestion(opts: OracleIngestionOptions = {}): Promise<void>;
export function stopOracleIngestion(): void;
```

One cycle:

```
getLatestLedger()
  → window = [checkpoint + 1, min(latest, checkpoint + MAX_WINDOW)]
  → getEvents({ filters: [['required','*'], ['EmergencyOracleUpdate','*']] })
  → for each event in window:
        parsed = parseOracleEvent(event)      // shared, already correct
        if (!parsed) { skipped++; continue }
        // Concern A — persistence. Own try/catch, own counter, own Sentry tag.
        try { await insertOracleFeedRow(parsed) } catch (e) { persistErrors++ }
        // Concern B — alerting. Independent try/catch; never blocks A.
        try { await evaluateAlert(parsed) }   catch (e) { alertErrors++ }
  → setListenerState(toLedger)
```

The critical property: **the checkpoint advances only after both concerns have
had their chance, and a failure in one does not abort the other or prevent the
checkpoint from moving.** Persistence failure on one event must not stall
ingestion; alerting failure must not drop an event from the audit feed.

### 2.1 `evaluateAlert(parsed)` — the real `processOracleEvent`

Lifted from `processOracleEvent` (70-105) but taking a `ParsedOracleEvent`
instead of pre-formatted strings, and with three fixes:

```ts
async function evaluateAlert(p: ParsedOracleEvent): Promise<void> {
  if (p.oldRequired === 0n) return;                 // unchanged guard

  // Signed, bigint — same arithmetic as insertOracleFeedRow (169-172),
  // so oracle_alerts.pct_change and oracle_price_feed.pct_change agree.
  const pctChange = Number(((p.newRequired - p.oldRequired) * 10000n) / p.oldRequired) / 100;
  if (Math.abs(pctChange) < thresholdPct) return;

  // Idempotency: without this, the trailing-window re-scan duplicates forever.
  await pool.query(
    `INSERT INTO oracle_alerts (importer_id, old_value, new_value, pct_change, tx_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (importer_id, tx_hash) DO NOTHING`,
    [p.importerId, p.oldRequired.toString(), p.newRequired.toString(),
     pctChange.toFixed(4), p.txHash]
  );
}
```

Three required changes, each traceable to §1.5:

1. **`p.importerId`, never `'mock-importer'.** `insertOracleFeedRow` (158-164)
   already resolves `importer_address → importers.id` and tolerates a null
   result; `evaluateAlert` should reuse that resolution and **skip alerting when
   it is null**, since `oracle_alerts.importer_id` is `NOT NULL REFERENCES
   importers(id)`. An alert for an address with no importer row is
   undeliverable anyway.
2. **A unique index on `oracle_alerts`**, matching the listener's pattern:

   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_alerts_importer_tx
     ON oracle_alerts(importer_id, tx_hash);
   ```

   Without it, correctness depends on the checkpoint never rewinding. The
   listener's persistence is safe under rewind only because
   `idx_oracle_price_feed_tx_importer` exists; alerting needs the same
   guarantee, and rewind *will* happen (manual `listener_state` correction after
   an incident).
3. **Signed `pct_change`** so an alert can distinguish a large decrease from a
   large increase.

Note `oracle_alerts.pct_change` is `NUMERIC(5,2)` (max 999.99) while the
listener writes `NUMERIC(7,4)`. `toFixed(4)` into a `NUMERIC(5,2)` column rounds
rather than errors, so this works, but widening the column to `NUMERIC(7,4)` for
consistency is a one-line migration and is proposed alongside.

### 2.2 What is deleted

- `apps/api/src/services/oracle-monitor.ts` — entirely. Its filter (§1.4),
  mocks (§1.5) and dead stop function go with it.
- Both `start*` calls in `index.ts:387-388` become one
  `startOracleIngestion()`.
- `services/oracle-event-listener.test.ts` is renamed and extended, not
  replaced: keep the existing `pollOracleEvents`/`getListenerState` coverage and
  add cases for the alert path.

Deleting the file is safe because `processOracleEvent` and `startOracleMonitor`
have no callers outside `oracle-monitor.ts` itself, verified by grep.

### 2.3 Failure isolation, explicitly

The issue asks how isolation is preserved. Concretely, in one loop:

| Concern | Failure mode | Containment |
| --- | --- | --- |
| RPC unavailable | whole cycle throws | outer `try` in the interval callback, `Sentry.captureException`, checkpoint untouched, next cycle retries from the same ledger — existing behaviour (302-306) |
| `parseOracleEvent` throws | one bad event | already returns `null` and logs (145-148); counted as `skipped`, loop continues |
| feed insert fails (FK, connection) | one event not persisted | inner `try` (256-265), `persistErrors++`, **alert evaluation still runs**, checkpoint still advances |
| alert insert fails | alerting degraded, audit feed intact | separate inner `try`, `alertErrors++`, persistence still fine |
| one event poisons the batch | infinite retry on a bad ledger | `skipped` events are counted and the checkpoint advances; a per-cycle `skipped > 0` metric distinguishes "nothing to do" from "unparseable events" |

That last row matters: the current listener advances the checkpoint past events
it could not parse (line 248 `break` on `toLedger`, then 268
`setListenerState(toLedger)`), which is the right call for an audit feed but
means malformed events are dropped silently. A `skipped` counter plus a
Prometheus gauge is the minimum that makes it visible.

### 2.4 Migration plan

1. Add `idx_oracle_alerts_importer_tx` and widen `pct_change` to `NUMERIC(7,4)`.
   **Do this first** — it is additive and makes step 3 idempotent.
2. Add `evaluateAlert` to `oracle-event-listener.ts` with the §2.1 signature, and
   call it from `pollOracleEvents` after `insertOracleFeedRow`. Add it behind
   `env.ORACLE_ALERTING_ENABLED` (default **false**) so the change ships dark.
3. Backfill nothing. `oracle_alerts` is empty and always has been (§1.4), so
   there is no historical alert state to reconcile — a rare and pleasant
   property of fixing this before it worked.
4. Verify with a real ledger: pick a recent `required` event from
   `oracle_price_feed`, confirm the derived `pct_change` matches
   `evaluateAlert`'s arithmetic, then enable the flag.
5. Add alerting assertions to `oracle-event-listener.test.ts`: an event below
   threshold inserts no alert; above threshold inserts exactly one; a repeated
   poll over the same range inserts no second alert.
6. Enable the flag. Confirm `oracle_alerts` gains rows and that re-running a
   cycle is a no-op.
7. Delete `oracle-monitor.ts`; collapse `index.ts:387-388` to
   `startOracleIngestion()`; add a SIGTERM handler calling
   `stopOracleIngestion()` (§1.7).

Steps 1-2 are strictly additive and independently revertable. Step 7 is the
first step that changes runtime behaviour, and by then alerting has been proven.

## 3. Trade-offs

**For consolidating.**

- Oracle alerting is dead today (§1.4-1.5). Consolidation is the mechanism that
  makes it work, because `evaluateAlert` needs a real parsed event and only the
  listener produces one. The alternative — fixing the monitor's filter in place
  — leaves two poll loops, two RPC clients, no checkpoint on one of them, and
  duplicated parse logic to keep in sync.
- One checkpoint is strictly better than one-and-a-half. The monitor's
  `sequence - 100` re-scan is not a checkpoint; it is a fixed window that cannot
  distinguish "no events" from "never ran", and cannot recover correctly after
  >100 ledgers of downtime. The listener's `listener_state` can.
- One `getEvents` call per cycle instead of two. At a 5 s ledger time this is
  roughly 12 calls/min instead of 18 — not the headline benefit, but real, and
  it halves the RPC rate-limit headroom consumed by this service.
- Deleting 106 lines of mock code removes a trap: its comments describe a
  monitoring design (`contract_events` table) that was never implemented, and a
  future reader could reasonably believe alerting works.

**Against.**

- The consolidated loop couples the audit feed's availability to the alert
  path's. Mitigated by per-concern `try`/`catch` and per-concern counters
  (§2.3), but "one loop" does mean one timer and one `getEvents` result; if
  `evaluateAlert` is slow, the cycle is slow. Since the checkpoint is set *after*
  both concerns, a slow alert path delays checkpoint advancement and can widen
  the next window. Cap alerting work per cycle (it is a threshold comparison
  plus one insert; the risk is low) and log when the cycle exceeds
  `POLL_INTERVAL_MS`.
- Alert evaluation is now on the ingestion hot path. A bug in `evaluateAlert`
  can no longer be isolated by simply not starting the monitor. The
  `ORACLE_ALERTING_ENABLED` flag in step 2 exists for exactly this, and should
  stay permanently.
- Consolidating is a bigger diff than fixing the filter, and the honest version
  of "we could just delete the monitor" is "we could just delete the monitor and
  never have alerting" — which is not what anyone wants.
- The consolidation loses the *option* of independent scaling. If alert
  evaluation ever needs to run more frequently than ingestion (e.g. checking
  prices rather than events), it will have to be split back out. Nothing in the
  current design suggests that need, and the `ParsedOracleEvent` seam makes the
  later split cheap.

**Rejected: keep them separate with different failure isolation.** This is the
alternative the issue explicitly allows. The case for it is real — persistence
should not depend on alerting — and it is why §2.3 keeps separate `try`/`catch`
per concern. What it does not survive is the cost: two RPC clients, two
pollers, two copies of topic-filter knowledge, and a second service whose only
contribution is currently a filter that matches nothing. Separate processes are
justified by separate *scaling or deploy* needs, and neither exists.

**Rejected: consolidate by deleting the listener and fixing the monitor.** The
listener has 316 lines, the correct filter, the checkpoint, the idempotency and
a test file; the monitor has 106 lines, a wrong filter and mocks. This direction
would mean rewriting the working component and discarding the tests.

**Rejected: monitor the `contract_events` table instead of polling RPC.** This
is the monitor's own suggestion in the comments at lines 44-45, and it is
tempting because the indexer already writes `contract_events` with a unique
index on `(ledger_sequence, event_index)` (`db.ts:309-310`) and the API already
reads it. It is worth a follow-up issue: it would remove this service's RPC
dependency entirely. It is out of scope here because `contract_events.kind`
coverage for oracle events is not established, and this RFC should not
restructure ingestion on an unverified assumption.

## 4. Open questions

1. Should `ORACLE_ALERT_THRESHOLD_PCT` be per-importer rather than global? Today
   it is one env value (`oracle-monitor.ts:81`), and a large importer moving
   collateral routinely will alert on every update.
2. Should alerts route to a real channel? Lines 95-104 only `logger.error` and
   branch on `env.ALERT_CHANNEL || 'console'`; both branches log, so the channel
   is currently cosmetic.
3. Should `evaluateAlert` alert on `EmergencyOracleUpdate` differently from a
   normal update? Emergency overrides are already flagged in
   `oracle_price_feed.emergency_override` and are arguably alert-worthy at any
   magnitude.
4. Is the `contract_events` alternative (§3) a better follow-up than tuning this
   service? If the indexer already sees every oracle event, ingestion is a
   solved problem and this loop should only alert, not persist.
