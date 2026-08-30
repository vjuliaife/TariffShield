# Investigation: `deposit_reserve` resource cost vs. deposit history

Issue: #1127

## Summary

`deposit_reserve` (`contracts/tariff-shield/src/lib.rs`) and `deposit_collateral`
(`lib.rs`) are structurally identical: both `load_account` the importer's single
persistent `DataKey::Account(importer)` record, run the same `require_active` /
`require_fresh_collateral` guards, perform **one** SAC `transfer` from the
depositor into `env.current_contract_address()`, `+=` a single balance field
(`reserve_balance` vs `collateral_balance`), and `save_account` the same
fixed-size record. Neither function appends anything — in particular,
`collateral_history` (the only growing field on `Account`) is written **only** by
`set_required_collateral`, never by a deposit.

Because every deposit rewrites the same two ledger entries (the importer's
`Account` and the contract's SAC token-balance entry — the shared write also
identified by #1089), the per-call resource cost should be **O(1) and independent
of how many deposits an importer has made in the past**. No per-deposit log grows
in contract storage.

## Benchmark

A benchmark was added to `contracts/tariff-shield/src/test.rs`
(`benchmark_deposit_cost_vs_prior_deposit_count`) using soroban-sdk 22's
testutils budget tracking (`cost_estimate().budget()` → CPU instructions +
memory bytes consumed), the same mechanism the existing
`benchmark_bulk_enforcement_paths` / `benchmark_register_importer_scaling` in
that file already use.

Two data sets are captured:

- **`DEPOSIT_BENCHMARK`** — end-to-end: N sequential real deposits
  (1 / 100 / 1000) followed by one more measured deposit, all through the
  contract client in one test env.
- **`DEPOSIT_BENCHMARK_ISOLATED`** — isolates the true per-call cost from the
  cumulative test-env artifact: prior deposit history is simulated as direct
  `DataKey::Account` state rewrites (the exact final ledger state N deposits
  would leave, without the N published diagnostic events), then one real
  deposit is measured.

Results (CPU instructions / memory bytes for the single measured call):

| Kind         | prior = 1        | prior = 100      | prior = 1000     |
| ------------ | ---------------- | ---------------- | ---------------- |
| reserve (end-to-end)   | 282306 / 47039   | 355644 / 94163   | 942576 / 522563  |
| collateral (end-to-end)| 282308 / 47039   | 355646 / 94163   | 942578 / 522563  |
| **reserve (isolated)** | **282306 / 47039** | **282306 / 47039** | **282306 / 47039** |
| **collateral (isolated)** | **282308 / 47039** | **282308 / 47039** | **282308 / 47039** |

## Interpretation

1. **`deposit_reserve` and `deposit_collateral` are cost-identical at every
   prior-deposit count.** Reserve vs collateral differ by exactly 2 CPU
   instructions (`282306` vs `282308`) regardless of history — they are the same
   code path modulo the field name.

2. **The isolated measurements are flat to the instruction.** At
   prior = 1 / 100 / 1000 the measured single call costs exactly
   282306 CPU / 47039 memory (reserve) and 282308 / 47039 (collateral). The
   true per-transaction resource cost on a ledger whose account has any number
   of prior deposits is constant — there is nothing that grows.

3. **The growth in the end-to-end column (942576 CPU @ 1000 priors) is a test
   harness artifact, not contract storage.** The budget tracker runs over the
   whole environment, so the accumulated diagnostic event log and snapshot
   footprint of 1000 prior client calls leak into the "measured" call. It is
   *identical for both kinds* (942576 vs 942578), confirming again that neither
   deposit path adds any growing history.

4. **Consistency with #1089:** the one true shared-state footprint per deposit
   is the SAC token-balance entry for `env.current_contract_address()` — the
   same ledger key every importer writes on deposit. Its *size* is fixed, so it
   contributes a constant write cost; what it constrains is ledger-close
   throughput (parallel-apply serialization), not per-call cost.

## Reproducing

```bash
cd contracts
cargo test --package tariff-shield benchmark_deposit_cost_vs_prior_deposit_count -- --nocapture
```

The `DEPOSIT_BENCHMARK*` lines print the numbers above. (Native test-env costs
are estimates — soroban-sdk's budget notes that VM/instantiation costs are
under-represented when running as native Rust — but the comparison is valid:
both kinds, over the same harness, identical and flat.)

## Acceptance criteria status

- [x] Benchmark `deposit_reserve` resource cost for accounts with few vs many
      prior reserve deposits — `benchmark_deposit_cost_vs_prior_deposit_count`
      in `contracts/tariff-shield/src/test.rs`
- [x] Compare the cost growth trend against `deposit_collateral` — identical
      code path; cost-identical at every measured prior count
- [x] Determine whether cost scales with the number of prior deposits — it does
      not: isolated per-call cost is constant (O(1), no grow­ing storage); the
      end-to-end rise is an identical-for-both test-env artifact
- [x] Report findings — this document; linked from #1127