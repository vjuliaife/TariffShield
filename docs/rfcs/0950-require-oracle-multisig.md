# RFC 0950: Require oracle multisig at `initialize()`

- Status: Proposed
- Issue: #950

## Summary

Multisig oracle governance is not just optional today; on a fresh deployment it
cannot be adopted at all, and `set_required_collateral` never consults it. This
RFC makes multisig a bootstrap requirement: `initialize()` takes the initial
signer set, and the single-signer `OracleAdmin` path is gated behind it.

## 1. Current state

`contracts/tariff-shield/src/lib.rs`:

- `initialize(admins, surety, token, oracle_admin, emergency_oracle_admin)`
  stores `OracleAdmin` and `EmergencyOracleAdmin`, then sets
  `OracleSigners = []` (empty `Vec`) and `OracleThreshold = 2`.
- `set_required_collateral(caller, ...)` authorizes **only** `caller ==
  OracleAdmin` (or `EmergencyOracleAdmin` with `emergency = true`). It never
  reads `OracleSigners` or `OracleThreshold`.
- `update_oracle_signers(new_signers, approvals)` requires `new_signers.len() == 3` and
  counts approvals that are members of the **current** `OracleSigners`,
  requiring `valid_count >= OracleThreshold`.
- `rotate_oracle_admin` swaps the single oracle admin, admin-gated.

### How a deployment stays single-signer forever

1. **Bootstrap deadlock.** `OracleSigners` starts empty, so `valid_count` is
   always 0 and `0 < 2` panics with `InsufficientSignatures`. No sequence of
   public calls can ever populate the set. The only test that exercises
   `update_oracle_signers` (`test.rs:1001`) writes `DataKey::OracleSigners`
   directly into storage first, which a real deployment cannot do.
2. **The multisig does not govern the sensitive call.** Even with a populated
   set, `set_required_collateral` ignores it. The signer set only guards
   rotation of itself. SDK/API code that passes several `Keypair`s to
   `setRequiredCollateral` co-signs the transaction, but the contract
   requires only the first signer to be the oracle admin.
3. **`update_oracle_signers` has no caller.** It takes no `caller` and only
   `require_auth`s approving signers, so it is not admin-gated either.

Net: production is single-oracle-admin by construction, and the "multisig" is
unreachable, so today the protection the docs imply does not exist.

## 2. Proposed gate

**A. Bootstrap signers in `initialize()`** (new-deployment path)

```rust
pub fn initialize(env, admins, surety, token, oracle_admin, emergency_oracle_admin,
                  oracle_signers: Vec<Address>, oracle_threshold: u32)
```

Validate `oracle_signers.len() == 3`, distinct, `1 <= threshold <= 3`
(`InvalidSignatureSet` otherwise); each signer `require_auth`s. Store them.
Reject `oracle_admin`/`emergency_oracle_admin` being in conflict as needed.

**B. Route oracle updates through the multisig**

`set_required_collateral` gains a required approval check: `caller` must be
the `OracleAdmin` **and** `approvals` (new arg, `Vec<Address>`) must contain
>= `OracleThreshold` distinct members of `OracleSigners`, each
`require_auth`ed. `OracleAdmin` becomes the submitter role, not the trust
root. `emergency` keeps its separate path (see §5).

**C. Explicit one-time gate for legacy state**

Add `DataKey::OracleMultisigEnabled: bool` and a `enable_oracle_multisig(admin,
signers, threshold)` entrypoint (admin-gated, one-shot):

- While `OracleMultisigEnabled == false`, `set_required_collateral` uses the
  legacy single-signer path (**bootstrap mode**), and emits an event tagged
  `singlesig` so it is observable.
- After `enable_oracle_multisig`, the legacy path is permanently closed.
- New deployments initialize with it already enabled (A).

**D. Fix `update_oracle_signers`**

Require an admin `caller` (or the existing multisig approvals **and** an
admin), so rotation is authorized by something other than "whoever is in the
set", and allow seeding only via `enable_oracle_multisig`.

## 3. Migration for an already-deployed instance

The contract already has `upgrade(new_wasm_hash)`, `propose_upgrade`/`approve_upgrade`, `version()` and `migrate_account`, so:

1. Ship the new WASM through the existing upgrade governance
   (`propose_upgrade` → `approve_upgrade`); `OracleMultisigEnabled` defaults to
   `false` (missing key), so behavior is unchanged at the moment of upgrade.
2. Admin calls `enable_oracle_multisig(admin, signers, threshold)` with the real
   signer set. The signers come from `oracle_signer_rotations` (admin API workflow, `#1018`) or a key ceremony.
3. Update SDK/API to pass `approvals` before step 2, so the switch is a config
   flip, not a code deploy. Use a compatibility-matrix entry
   (`packages/sdk/src/compatibility.ts`) for the new signature.
4. After the gate flips, monitor for `singlesig` events; there should be none.

Because `initialize`'s signature changes, `scripts/deploy-contracts.ts` and
docs (`docs/deployment.md`, `docs/mainnet-migration.md`) must be updated, and
`deployments/` history records the multisig config at deploy time.

## 4. Errors and tests

| Change | Detail |
| --- | --- |
| Reuse `InvalidSignatureSet = 21` | bad length/duplicates/threshold in `initialize` and `enable_oracle_multisig` |
| Reuse `InsufficientSignatures = 22` | `set_required_collateral` with too few approvals |
| **New** `MultisigAlreadyEnabled = 23` | second call to `enable_oracle_multisig` |
| **New** `MultisigNotEnabled = 24` | only if a strict mode ever refuses the legacy path, e.g. a build flag |

New variants append at the end so existing `repr(u32)` values stay stable (see
RFC 0948; regenerate the TS map).

`test.rs` additions (currently it seeds storage directly at line 1001; replace
that with real calls):

- `initialize` rejects != 3 signers, duplicate signers, threshold 0 or > 3.
- Fresh `initialize` leaves multisig enabled and `get_oracle_signers` returns the set.
- `set_required_collateral`: succeeds with threshold approvals; `InsufficientSignatures` with fewer; non-member approvals ignored; duplicate approval -> `InvalidSignatureSet`; wrong caller -> `UnauthorizedRole`.
- Legacy instance (multisig not enabled): single-signer still works and emits `singlesig`.
- `enable_oracle_multisig`: admin-only, one-shot (`MultisigAlreadyEnabled`), closes the legacy path.
- `update_oracle_signers` after bootstrap rotates with threshold approvals and is not callable by a non-admin alone.
- Emergency path behavior (whatever is decided in §5) stays covered.

## 5. Open questions

- **Emergency override:** `EmergencyOracleAdmin` bypasses the rate limit by
  design. Recommendation: keep it single-signer but require `OracleThreshold`
  approvals too, or restrict it to *lowering* required collateral. Needs a
  product decision.
- Threshold: keep the hard-coded 2-of-3, or make it configurable in `initialize`
  (proposed above)?

## 6. Trade-offs

**Enforce:** production cannot silently run on one key; the signer set becomes
reachable and meaningful; aligns behavior with the security docs; the legacy
mode is observable and one-way.

**Cost for dev/test:** every test/dev environment must now supply three signers.
Mitigate with a test helper (`Setup::with_multisig()`) and a documented
"bootstrap mode" that skips `enable_oracle_multisig` on local/testnet only. It is
never a compile-time default for mainnet, and mainnet deploy scripts should assert `OracleMultisigEnabled`.

**Risks:** changes the `set_required_collateral` and `initialize` ABI (SDK
compat entry and coordinated API deploy needed); a mis-seeded signer set can
lock oracle updates, so rotation must remain possible via an admin path;
approval collection adds latency to routine oracle updates, which are already
rate-limited to once per 24 hours.
