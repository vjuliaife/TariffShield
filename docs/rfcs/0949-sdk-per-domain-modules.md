# RFC 0949: Split `packages/sdk/src/index.ts` into per-domain modules

- Status: Proposed
- Issue: #949

## Summary

Keep one public `TariffShieldClient`, but implement it from composable
per-domain modules that share a single invocation core. `index.ts` becomes a
thin re-export, so no import path or method signature changes.

## 1. Inventory

`packages/sdk/src/index.ts` is currently 548 lines (the issue text says 426).
It contains **two clients**, which matters for the split:

**`TariffShieldApiClient`** (HTTP, `apps/api`): `getHeaders`, `getImporter`,
`getCollateralHistory`, `createDepositSchedule`, `scheduleWithdrawal`,
`createApiKey`, `listApiKeys`, `revokeApiKey`.

**`TariffShieldClient`** (Soroban), grouped by domain:

| Domain | Methods |
| --- | --- |
| Lifecycle/admin | `initialize`, `transferAdmin`, `version`, `getAdmin`, `getSurety`, `getToken` |
| Account/collateral | `registerImporter`, `depositCollateral`, `depositReserve`, `autoTopUp`, `withdrawCollateral`, `accrueYield`, `clawback`, `getAccount`, `getCollateralHistory` |
| Oracle | `setRequiredCollateral`, `getOracleSigners`, `updateOracleSigners` |
| Disputes | `raiseDispute`, `resolveDispute` |
| Core (private) | `simulate`, `invokeAndSubmit`, `invokeAndSubmitMulti`, plus `addressToScVal` and connection retry/compat wiring |

**Gap:** the contract exposes `propose_upgrade`, `approve_upgrade`,
`cancel_upgrade`, `rotate_oracle_admin`, `get_oracle_admin`, `set_price_oracle`,
`get_price_oracle`, `is_collateral_stale`, `migrate_account` and `upgrade`, none of
which the SDK wraps. The issue expects an "upgrade governance" domain, but
today it does not exist in the SDK; the split creates a place for it.

`compatibility.ts` (+ test) is already a separate module and is the model to follow.

## 2. Proposed module boundary

```
packages/sdk/src/
  index.ts                 // re-exports only
  client.ts                // TariffShieldClient: constructs core, mixes in domains
  core/invoker.ts          // simulate, invokeAndSubmit(Multi), retry, compat gate, error parsing
  core/scval.ts            // addressToScVal and shared ScVal helpers
  domains/account.ts       // register, deposit*, withdraw, autoTopUp, accrueYield, clawback, getAccount, history
  domains/oracle.ts        // setRequiredCollateral, getOracleSigners, updateOracleSigners
  domains/disputes.ts      // raiseDispute, resolveDispute
  domains/admin.ts         // initialize, transferAdmin, getters, version
  domains/upgrade.ts       // NEW: propose/approve/cancel_upgrade (follow-up)
  api-client.ts            // TariffShieldApiClient (HTTP)
  compatibility.ts         // unchanged
```

Each domain is a factory `(core: Invoker) => { ...methods }`. `TariffShieldClient`
composes them and forwards, so `client.depositCollateral(...)` still works:

```ts
export class TariffShieldClient {
  constructor(opts) { const core = new Invoker(opts); Object.assign(this, account(core), oracle(core), /* ... */); }
}
```

TypeScript typing: declare the class's methods via an interface merged from
each domain's return type (`interface TariffShieldClient extends AccountApi, OracleApi, DisputeApi, AdminApi {}`), so `.d.ts` output is identical in shape.

The shared **invocation core** owns everything currently duplicated or private:
`simulate`, `invokeAndSubmit`, `invokeAndSubmitMulti`, timeout, fee, polling,
the compatibility gate and (per RFC 0948) contract-error parsing. Domain
modules only build `ScVal` args and parse return values.

## 3. Keeping the public surface stable

- `index.ts` re-exports every current export by name: `TariffShieldClient`,
  `TariffShieldApiClient`, the interfaces (`TariffShieldAccount`,
  `CollateralHistoryEntry`, `InvokeResult`, `*Options`), and `CompatibilityError`.
- Add an **API-surface test**: instantiate the client and assert each expected
  method name exists, and snapshot the `dist/index.d.ts` export list, so any
  accidental removal fails CI.
- `package.json` `main`/`types`/`exports` stay pointing at `dist/index.*`.
  Subpath exports (`@tariffshield/sdk/oracle`) may be added later but are not
  required, so tree-shakeability is a bonus, not a contract.
- `apps/api` consumes the built `dist` (see `api-integration.yml`); the split is
  invisible to it.

## 4. Test organization (target: 90% SDK line coverage, `docs/test-strategy.md`)

Today the SDK's only test is `compatibility.test.ts` (`npm test` runs just that
file), and `test-strategy.md` lists SDK coverage as "Not yet configured".
Proposed layout, mirroring the source tree:

```
packages/sdk/src/__tests__/
  core/invoker.test.ts       // mock rpc.Server: simulate error, send error, NOT_FOUND polling, timeout, retry
  domains/account.test.ts    // arg encoding + return parsing per method
  domains/oracle.test.ts     // multi-signer path, empty-signers error
  domains/disputes.test.ts
  api-client.test.ts         // fetch mock: headers, error bodies
  public-surface.test.ts     // export/method inventory
```

- Inject a fake `Invoker` into each domain so tests never touch RPC; this is
  the main testability gain of the split.
- Change the `test` script to `tsx --test "src/**/*.test.ts"` and add `c8`
  (or `node --experimental-test-coverage`) with a 90% line threshold on
  `src/`, enforced in CI once the suite passes.
- Order of work: core first (highest fan-in), then account, oracle, disputes.

## 5. Trade-offs

**Split:** smaller reviewable files; a domain is testable with a fake core;
one place for RPC/parsing logic and error handling; room for the missing
upgrade-governance domain without growing `index.ts` further.

**Keep one file:** zero churn, one place to read, no composition indirection.
At 548 lines it is still manageable, and the real growth risk is the
unwrapped contract methods listed above.

**Costs:** mixin/composition typing is fiddlier than a class body; stack traces
and go-to-definition go through one more layer; internal churn conflicts with
open SDK PRs (mitigate with move-only PRs); a slight risk of `d.ts` drift,
covered by the surface test.
