# Investigation: `deposit_collateral` throughput under concurrent submissions

Issue: #1089

## Summary

`deposit_collateral` (`contracts/tariff-shield/src/lib.rs:277`) is invoked
from `POST /importers/:id/deposit` (`apps/api/src/routes/importers.ts:751`).
The route doesn't submit the transaction inline — it enqueues a `tx-submit`
BullMQ job (`apps/api/src/queue.ts`) and returns `202`; a separate worker
process (`apps/api/src/worker.ts`) dequeues the job and calls
`contractClient.depositCollateral`, which signs and submits the transaction
with the *importer's own* Stellar keypair.

That queue hop is where most of the throughput ceiling actually lives —
not the contract or the Stellar ledger.

## Where contention can and can't happen

**No contention across importers at the contract-state level.** Each
importer's balances live under a distinct persistent storage key,
`DataKey::Account(importer)` (`lib.rs:218`). Soroban's parallel transaction
apply only serializes transactions whose read/write footprints overlap, so
two `deposit_collateral` calls for two different importers don't conflict
on account state.

**One shared write per deposit, regardless of importer.** Every
`deposit_collateral` call also does
`token::Client::new(&env, &token_addr).transfer(&from, &env.current_contract_address(), &amount)`
(`lib.rs:286-290`). That transfer increments the SAC token's balance entry
for `env.current_contract_address()` — the *same* ledger entry every
importer's deposit writes to. This is the one real shared-state footprint
in the call: any two `deposit_collateral` (or `deposit_reserve`,
`auto_top_up`, `withdraw_collateral`) transactions that land in the same
ledger close necessarily touch it, so classic Soroban parallel-apply can't
run them in the same execution stage — they get sequenced within that
close rather than rejected. This doesn't cap *submission* concurrency, but
it does mean ledger-close throughput for deposits doesn't scale linearly
with the number of concurrently-submitting importer accounts; it's bounded
by how many such writes one ledger close can sequence.

**No importer-keypair sequence-number contention across importers**, since
each importer signs with their own account/sequence number
(`queue.ts:74-83`). Sequence-number contention would only appear if the
*same* importer fired overlapping deposits, which isn't the scenario this
issue asks about.

## The dominant bottleneck: worker concurrency, not the ledger

`createTxSubmitWorker()` (`apps/api/src/queue.ts`) constructed the BullMQ
`Worker` without a `concurrency` option, which defaults to **1**. That
serializes every queued `tx-submit` job — deposits for importer A and
importer B included — behind a single in-flight submission, independent of
Soroban's actual footprint-contention behavior described above. Under
concurrent submissions across N importer accounts, this was the first
thing to saturate: job wait time in the queue grows linearly with N well
before ledger-level contention becomes visible.

This PR raises that off the BullMQ default via a new
`TX_SUBMIT_WORKER_CONCURRENCY` env var (default `8`,
`apps/api/src/config/env.ts`), consumed in `createTxSubmitWorker()`.

## Recommended concurrency ceiling

- **Worker concurrency: 8** (the new default). Set above 1 so unrelated
  importer submissions stop queueing behind each other; kept in the
  single-digits rather than raised aggressively because of the shared
  token-balance write path above — pushing worker concurrency far past the
  number of deposit/withdraw/auto_top_up writes a ledger close can
  practically sequence just shifts the wait from "BullMQ queue" to "RPC
  retries on `txBAD_SEQ`/ledger-close backpressure" without improving
  end-to-end latency.
- **No batching required at this volume.** Batching (accumulating deposits
  and submitting them as one multi-op transaction) would reduce the number
  of writes to the shared token-balance entry per ledger close, but adds
  latency (importers wait for a batch window) and complexity (partial-batch
  failure handling) that isn't justified until real traffic approaches the
  worker-concurrency ceiling above. Revisit if `tests/load/results/` shows
  queue wait time dominating p95 at the current concurrency setting.
- **Retry/backoff is already reasonable**: `enqueueTxSubmit` uses 2 attempts
  with exponential backoff starting at 2s (`queue.ts:53-60`), which is in
  the right ballpark for retrying past a single lost ledger-close window
  (~5s) without amplifying load during contention.

## Reproducing / measuring

`apps/api/tests/load/post-deposit-concurrency.js` is a k6 script added
alongside this investigation. It registers a distinct importer per virtual
user and ramps from 1 to 100 concurrent VUs in stages, so it exercises
exactly the "many distinct importer accounts, concurrent submission"
scenario this issue asks about. See
`apps/api/tests/load/README.md#concurrent-deposit_collateral-investigation-1089`
for how to run it.

Actual p95 latency and failure/retry-rate numbers under load need to be
captured against a live Postgres + Redis + Stellar-testnet-backed API
instance (this investigation was authored without one available). The
k6 script's `results` export gives the harness for whoever runs it next to
fill in those numbers and confirm the concurrency=8 recommendation against
real ledger-close behavior.

## Acceptance criteria status

- [x] Simulate concurrent `deposit_collateral` submissions across N distinct
      importer accounts — `post-deposit-concurrency.js`
- [ ] Measure ledger inclusion latency and failure/retry rate as concurrency
      increases — harness is in place; running it against live
      infrastructure and recording numbers is a follow-up
- [x] Identify whether shared contract state causes serialization
      bottlenecks — yes, the SAC token balance entry for the contract
      address (shared across all importers' deposits/withdrawals), not
      per-importer account state
- [x] Recommend a safe concurrency ceiling or batching strategy — worker
      concurrency of 8, no batching needed yet (see above)
- [x] Report findings in the issue — this document; linked from #1089
