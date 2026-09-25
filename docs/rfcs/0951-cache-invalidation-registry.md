# RFC 0951: A declarative cache-invalidation registry for the tx-submit queue

- Status: Proposed
- Issue: #951

## Summary

Replace the hand-written `if (method === 'deposit' || ...)` in
`apps/api/src/queue.ts` with a typed table that maps every `TxSubmitJobData`
method to the cache effects of that write. A compile-time exhaustiveness check
makes it impossible to add a method without deciding.

## 1. Current state

`apps/api/src/cache.ts` caches one thing: the on-chain account view for
`GET /importers/:id` under `onchain:importer:<id>`, TTL **30 s**, fail-open. The
cached fields are `bondId`, `collateralBalance`, `requiredCollateral`,
`reserveBalance`, `yieldAccrued`, `isClawbacked`. `invalidateOnChainAccount(importerId)` deletes the key.

### `TxSubmitJobData` methods vs. worker invalidation

The worker (`queue.ts:181`) runs:
`if (method === 'deposit' || method === 'withdraw' || method === 'clawback') invalidateOnChainAccount(importerId)`.

| Method | On-chain effect | Cached field(s) affected | Invalidated by worker? |
| --- | --- | --- | --- |
| `register` | creates account | all (`bondId`, balances, required) | **No** |
| `deposit` (`collateral` or `reserve` bucket) | +collateral or +reserve | `collateralBalance` or `reserveBalance` | Yes |
| `auto_top_up` | moves reserve -> collateral | `collateralBalance`, `reserveBalance` | **No** |
| `withdraw` | -collateral | `collateralBalance` | Yes |
| `accrue_yield` | +yield | `yieldAccrued` | **No** |
| `clawback` | zeroes balances, sets flag | balances, `isClawbacked` | Yes |
| `set_required_collateral` | changes required | `requiredCollateral` | **No** (worker); route invalidates before enqueue |

Three write methods that change cached fields (`auto_top_up`, `accrue_yield`,
`register`) do not invalidate on confirmation, and `set_required_collateral`
relies on other code paths. A client can read a stale value for up to 30 s
after `auto_top_up` or `accrue_yield` confirm.

### Other invalidation sites (outside the worker)

`routes/importers.ts` at 1485, 1578, 2308 and `services/scheduled-withdrawals.ts:126` call
`invalidateOnChainAccount` directly. The comment at `queue.ts:174-180`
explains a real race: routes invalidate *before* the tx confirms, so a GET can
re-cache pre-write state; the worker's post-confirmation invalidation is what
fixes that, which is why the missing methods matter.

The coupling is invisible to the type system: `switch (method)` in the worker
has no `default`, and the invalidation condition is a separate hand-maintained list.

## 2. Proposed registry

`apps/api/src/cache-effects.ts`:

```ts
import type { TxSubmitJobData } from './queue.js';
type Method = TxSubmitJobData['method'];

export type CacheEffect =
  | { kind: 'onchain-account' }   // invalidate onchain:importer:<importerId>
  | { kind: 'none'; reason: string }; // explicit opt-out, must justify

export const METHOD_CACHE_EFFECTS: Record<Method, readonly CacheEffect[]> = {
  register:                { ... } ,
  deposit:                 [{ kind: 'onchain-account' }],
  auto_top_up:             [{ kind: 'onchain-account' }],
  withdraw:                [{ kind: 'onchain-account' }],
  accrue_yield:            [{ kind: 'onchain-account' }],
  clawback:                [{ kind: 'onchain-account' }],
  set_required_collateral: [{ kind: 'onchain-account' }],
};

export async function applyCacheEffects(method: Method, importerId: string): Promise<void>;
```

- `Record<Method, ...>` makes TypeScript **fail to compile** when a new method
  is added to the union without an entry. This is the primary guard.
- `kind: 'none'` needs a `reason`, so opting out is visible in review.
- The registry lives beside `cache.ts` and imports only the method **type**
  from `queue.ts`; `applyCacheEffects` calls `cache.ts` functions. That avoids a
  runtime import cycle (`queue.ts` imports the registry, not the reverse).
- Effects are keyed by *cache key kind*, not raw strings, so if a second cache
  (e.g. importer metrics) appears, add a new `CacheEffect` kind rather than a new ad hoc call.

Worker change: replace the `if` at `queue.ts:181` with
`await applyCacheEffects(method, importerId)` (unconditional, after the event insert).

## 3. Lint / test enforcement

1. **Type-level:** the `Record<Method, ...>` above (compile error).
2. **Unit test** `cache-effects.test.ts`: derive the method list from a single exported
   `TX_SUBMIT_METHODS` `as const` array (also used to define the `method` union), and assert
   the registry has exactly those keys, and that every `none` entry has a non-empty `reason`.
3. **Switch exhaustiveness:** add `default: assertNever(method)` to the worker's
   `switch` so a method with no handler cannot compile either.
4. **Optional ESLint** rule: forbid importing `invalidateOnChainAccount` in
   `apps/api/src/{routes,services,jobs}` except through the registry, once the direct calls are migrated.

## 4. Rollout

1. Add `TX_SUBMIT_METHODS`, derive the union from it, add the registry and its
   test. Populate it as above, **including the four methods currently missing**.
   This alone fixes the stale-read bug.
2. Swap the worker's `if` for `applyCacheEffects`; add `assertNever`.
3. Leave the route-side pre-enqueue invalidation as is (it serves a different
   purpose: clearing before the write is queued); document that in the registry header.
4. Migrate `scheduled-withdrawals.ts:126` and other direct callers to
   `applyCacheEffects` in follow-ups, then turn on the ESLint rule.
5. Add a metric label (`method`) to `cache_operations_total` if useful to observe invalidation per method.

Risk is low: the change only adds invalidations. The cost of an extra `DEL` is
one Redis call, and it fails open.

## 5. Trade-offs

**Registry:** a new method cannot ship without an explicit cache decision;
fixes 4 real gaps immediately; one table to read when debugging staleness; leaves room for multiple cache keys.

**Current direct calls:** simplest possible code, no indirection. But the
audit shows it already drifted (4 of 7 methods).

**Costs:** one more small module; developers must touch it when adding a job
method (that is the point); the registry says *which* effect, not *whether the
write actually changed that field*, so it may over-invalidate (harmless, since the TTL is 30 s).
It also does not cover writes outside the queue (direct SDK calls from routes) unless those are migrated.
