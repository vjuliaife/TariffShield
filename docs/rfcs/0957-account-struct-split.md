# RFC 0957: Should the monolithic `Account` be split into lifecycle-scoped sub-records?

- Status: Proposed
- Issue: #957

## Summary

Recommendation: **do not do the three-way split** (collateral / dispute /
oracle-tracking). It would make the hottest entrypoints read and write *more*
ledger entries, and most of what it would save is bytes that only one field
accounts for. Do a **narrow split instead: move `collateral_history` into its
own entry** (`DataKey::CollateralHistory(Address)`), and add an explicit
schema version to the account so future changes have a defined migration path.
The rest of this RFC shows the reasoning and gives the concrete design, since
the issue asked for the split to be evaluated.

Caveat on numbers: the sizes below are **derived by hand from the XDR encoding
rules**, not measured; the sandbox this RFC was written in could not build the
Soroban workspace (no crate downloads). Section 6 gives the measurement test to
run before any implementation PR, and the recommendation should be revisited if
it disagrees materially.

## 1. Current model

```rust
pub struct Account {            // one persistent entry: DataKey::Account(importer)
    bond_id: u64,
    collateral_balance: i128,   required_collateral: i128,
    reserve_balance: i128,      yield_accrued: i128,
    is_clawbacked: bool,        collateral_last_updated: u64,
    collateral_history: Vec<CollateralHistoryEntry>,   // capped at 12 (#331)
    dispute_expires_at: u64,    pre_dispute_required: i128,  dispute_raised: bool,  // #336
    oracle_last_updated: u64,                                                   // #326
}
```

`load_account`/`save_account` (`lib.rs`) read and write the whole struct through
one `persistent()` entry. The contract has no `extend_ttl` call anywhere (checked
by search), and `migrate_account(admin, importer, new_account: Account)`
overwrites the entry with an admin-supplied full struct.

### Which entrypoint touches which fields

`R` = read, `W` = written. Groups: **C** = `collateral_balance`, `reserve_balance`,
`yield_accrued`, `is_clawbacked`, `bond_id`; **Req** = `required_collateral`,
`collateral_last_updated`; **D** = `dispute_expires_at`, `pre_dispute_required`,
`dispute_raised`; **O** = `oracle_last_updated`; **H** = `collateral_history`.

| Entrypoint | C | Req | D | O | H |
| --- | --- | --- | --- | --- | --- |
| `register_importer` | W (init) | W (init) | W (init) | W (init) | W (init) |
| `deposit_collateral` / `deposit_reserve` | RW | R (staleness) | . | . | . |
| `withdraw_collateral` | RW | R | R (`effective_required`) | . | . |
| `auto_top_up` | RW | R | R (`effective_required`) | . | . |
| `accrue_yield` | RW | . | . | . | . |
| `clawback` | RW | . | . | . | . |
| `raise_dispute` | R (`is_clawbacked`) | R (event payload) | RW | . | . |
| `resolve_dispute` | . | RW (if rejecting) | RW | . | . |
| `set_required_collateral` | . | RW | W | RW | RW |
| `get_collateral_history` | . | . | . | . | R |
| `get_account`, `is_collateral_stale` | R | R | R | R | R |

Observations from the table:

1. **`H` is touched by exactly two mutating paths** (`register_importer`,
   `set_required_collateral`), which run at most once per 24h per importer
   (the oracle rate limit). Yet every deposit, withdrawal, top-up, yield
   accrual, clawback and dispute call **reads and re-writes it** as part of the
   monolithic entry.
2. **`D` is read by the two hottest money paths** (`withdraw_collateral`,
   `auto_top_up`, via `effective_required`) as well as written by dispute
   calls. It is not an independent lifecycle from `C` and `Req`.
3. **`O` (one `u64`) is only used by `set_required_collateral`.**
4. `raise_dispute` reads `pre_dispute_required`/`required_collateral` (event
   payload) and `is_clawbacked`, so it is not a pure `D` operation either.

## 2. Storage cost model (what the split would trade)

Soroban charges a transaction along several resource axes; the ones that a
split moves are:

- **Number of ledger entries read and written** (a fixed cost per entry, and
  hard per-transaction limits on entry counts).
- **Bytes read and bytes written** (per-byte fees and per-transaction byte limits).
- **Rent**, proportional to entry size and how long it is kept alive, paid
  per entry.
- Each entry also carries fixed **overhead** (the key and the ledger-entry wrapper),
  roughly 100 to 150 bytes independent of the value.

Exact fee rates and limits are network settings that change by protocol
version, so this RFC deliberately gives no stroop figures. Use the simulation
in section 6 for the current numbers.

### Size of the current entry (derived from XDR rules)

`Account` is an `ScMap` of 12 symbol-keyed fields. Using XDR sizes
(`u64` = 12, `i128` = 20, `bool` = 8, symbol key = 8 + name padded to 4, map
header = 12, `Vec` header = 12):

| Part | Bytes |
| --- | --- |
| Map header + 11 scalar fields (everything except history) | ~460 |
| `collateral_history` field, empty | ~40 |
| each `CollateralHistoryEntry` (`{value: i128, timestamp: u64}`) | ~80 |
| **Account, 0 history entries** | **~500** |
| **Account, 12 history entries (the cap)** | **~1,460** |

So for an importer whose collateral requirement has changed 12+ times,
**about two thirds of every entry is history**, and every `deposit`/`withdraw`
pays to read and write it. The dispute + oracle-tracking group (`D` + `O`) is
only about 160 bytes (about a third of the *empty* entry, about 11% of a full one).

## 3. Options evaluated

### Option A: the split proposed in the issue

```rust
DataKey::Account(Address)   // C + Req (core)
DataKey::Dispute(Address)   // D
DataKey::OracleMeta(Address)// O + H (or O and H separately)
```

| Entrypoint | Entries touched today | Entries touched with option A |
| --- | --- | --- |
| `deposit_*` | 1 R, 1 W | 1 R, 1 W (no change) |
| `withdraw_collateral`, `auto_top_up` | 1 R, 1 W | **2 R** (core + dispute), 1 W |
| `raise_dispute` | 1 R, 1 W | 2 R (core for `is_clawbacked` and event), 1 W |
| `set_required_collateral` | 1 R, 1 W | 3 R, **3 W** |
| `register_importer` | 1 W | 3 W (and 3 rent payments) |

Byte savings exist (`deposit`, `accrue_yield`, `clawback` shed the D+O+H bytes),
but two of the hottest paths read an extra entry (each read pays the fixed
per-entry cost plus ~100-150 B of key and wrapper overhead, which is comparable
to the 160 B of dispute fields it would avoid loading), and the oracle path
triples its write count. **Net for `withdraw`/`auto_top_up`: likely worse.**
The only clear winner is `raise_dispute`/`resolve_dispute` on bytes, and those
are rare.

### Option B (recommended): extract history only

```rust
DataKey::Account(Address)             // everything except history (~500 B)
DataKey::CollateralHistory(Address)   // Vec<CollateralHistoryEntry> (0-960 B)
```

| Entrypoint | Entries touched |
| --- | --- |
| all money paths, disputes, `clawback` | 1 R, 1 W, **and at most ~500 B instead of up to ~1,460 B** |
| `set_required_collateral` | 2 R (account + history), 2 W |
| `register_importer` | 1 W + no history entry until first oracle update (lazily created) |
| `get_collateral_history` | 1 R of the history entry only (currently loads the whole account) |

This removes the one field that is large, unbounded up to its cap, and used by
almost nothing, at the price of one extra entry on a path that already runs at
most once a day per importer. Lazily creating the history entry also makes
freshly registered importers cheaper than today.

### Option C: keep one struct, minimal change

No storage change; add only `schema_version`. Zero footprint risk, but keeps the
~1.4 KB entry on every money path for mature accounts.

## 4. Concrete design for option B

```rust
pub enum DataKey {
    ...
    Account(Address),              // existing
    CollateralHistory(Address),    // new
}

#[contracttype]
pub struct Account {               // v2: history field removed, version added
    pub schema_version: u32,       // = 2
    ... all current fields except collateral_history ...
}
```

- `load_account` is unchanged for callers. Add `load_history`/`save_history`
  used only by `set_required_collateral`, `get_collateral_history`.
- **TTL must be handled per entry.** The contract calls no `extend_ttl` today
  (for a persistent `Account` too). Splitting means two entries that can
  archive independently; a restore of one without the other must not corrupt
  state. Because history is append-only audit data that is never read on money
  paths, an archived history entry is not a correctness problem for
  deposits/withdrawals (it is only needed for `set_required_collateral` and
  `get_collateral_history`, which would then need a restore in their
  footprint). Adding explicit `extend_ttl` for both keys on write is a
  prerequisite regardless of the split.
- **Cross-record consistency** is small here: history is derived, append-only
  data written in the same call that updates `required_collateral`. The failure
  mode to test is "history entry exists but account entry write reverts",
  which cannot happen because a Soroban invocation is atomic (all writes
  commit or none do).

## 5. Migration path for existing accounts

A `#[contracttype]` struct is an exact-shape `ScMap`, so **an entry written as
today's `Account` cannot be decoded as a struct with a different field set.**
This is why `migrate_account` today requires the admin to pass the entire new
struct (it overwrites without reading the old entry), and why *any* change to
`Account`, including the changes already merged for #326/#331/#336, is a
breaking storage change.

Recommended: **lazy migration through a versioned key**, so no flag day and
no per-account admin transaction:

1. Keep the old struct as `AccountV1` (frozen, for decoding only).
   Add `DataKey::AccountV2(Address)` for the new shape.
2. `load_account(env, importer)`: read `AccountV2`; if absent read the old
   `Account` key as `AccountV1`, convert (`history` moves to
   `CollateralHistory(importer)`, `schema_version = 2`), write the new entries,
   remove the old key, return the account. Because the first write happens
   during a normal user call, the caller pays the one-time migration write.
3. `save_account` only ever writes V2.
4. `migrate_account` (admin) becomes the *eager* path: takes the V2 struct and
   history, for accounts an operator wants to move proactively or repair.
5. Ship behind `upgrade()`; bump `version()` (currently the hard-coded
   `v0_3_0`).
6. Once every account has been observed as V2 (the `migrat` event can be
   emitted on lazy migration too, and counted by the indexer), delete the V1
   read path in a later release.

Testing needs a snapshot of a V1-shaped entry as the fixture (the repo already
keeps `test_snapshots/`), and a test per entrypoint that starts from V1 state.

## 6. How to validate before implementing

1. Add a `#[cfg(test)]` test that builds `Account` with 0, 1, 6 and 12 history
   entries and prints `account.to_xdr(&env).len()`; compare with the ~500 / ~1,460
   B derived above.
2. Use the resource estimates of `env.cost_estimate().resources()` (soroban-sdk
   22) around `withdraw_collateral`, `deposit_collateral` and
   `set_required_collateral` for one-entry vs. two-entry layouts, or
   `stellar contract invoke --sim-only` against a deployed test contract, and
   compare `read_entries`/`write_entries`/`read_bytes`/`write_bytes`. Re-derive
   fees from *current* network settings.
3. If option B's deltas are small against those numbers, prefer option C.

## 7. Trade-offs summary

| | A: 3-way split | B: history only | C: one struct + version |
| --- | --- | --- | --- |
| Bytes on money paths | lowest | low (~500 B cap) | highest (up to ~1.4 KB) |
| Entries on `withdraw` / `auto_top_up` | 2 R | 1 R | 1 R |
| Entries on `set_required_collateral` | 3 R / 3 W | 2 R / 2 W | 1 R / 1 W |
| Migration surface | 3 shapes | 1 field moved | none now |
| TTL/archival obligations | 3 entries | 2 entries | 1 entry |
| Cross-record consistency | dispute vs. core coupled | trivial (derived data) | none |

**Efficiency and clearer migration boundaries vs. cross-record consistency
and more keys:** for this struct, the second cost outweighs the first except for
`collateral_history`, which is why the recommendation is B, plus an explicit
schema version so the next field addition does not need an ad hoc migration.
