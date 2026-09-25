# RFC 0948: Generate a typed error-code mapping from `errors.rs`

- Status: Proposed
- Issue: #948

## Summary

Emit a TypeScript enum and message map from
`contracts/tariff-shield/src/errors.rs` with a small codegen script, publish it
from `packages/sdk`, and have `apps/api` and the SDK translate contract failures
through it instead of matching strings. CI fails if the generated file is stale.

## 1. Current call sites

The Rust enum has 22 variants (`repr(u32)`, values 1-22). Every place that
interprets a contract failure today:

| Site | What it does |
| --- | --- |
| `apps/api/src/routes/importers.ts:1512` | The **only** code-aware call site. Matches `errMsg.includes('Error(Contract, #13)') \|\| errMsg.includes('RateLimitExceeded')` and maps it to HTTP 429 with a `Retry-After`. `#13` is a hand-copied `RateLimitExceededError`. |
| `packages/sdk/src/index.ts:440` `simulate()` | Throws `Error("simulate <method> failed: <raw sim.error>")`. No code extraction. |
| `packages/sdk/src/index.ts:469, 510` `invokeAndSubmit*()` | Throws `Error("send failed: <JSON errorResult>")`. |
| `packages/sdk/src/index.ts:521` | Throws `Error("tx <hash> status=... (<base64 XDR>)")`. |
| `apps/api/src/queue.ts` worker | Lets the SDK error propagate to BullMQ unchanged. |
| `apps/web/lib/error-formatter.ts` | Formats API errors only. It has no knowledge of contract error codes. |

So 21 of the 22 variants (everything except `#13`) reach callers as opaque
strings. Note the second matcher, `'RateLimitExceeded'`, would never match a
real Soroban error, because the Rust variant is named `RateLimitExceededError`.
It only works today because the numeric matcher does. That is exactly the
drift this RFC targets.

## 2. Proposed approach

**Source of truth:** `errors.rs`. Its shape is regular (`Name = N,` inside one
`enum Error`, with `//` comments above some variants), so a parser is enough.
No macro or rustdoc JSON is needed.

**Generator:** `scripts/gen-contract-errors.ts` (Node, no new deps, run with
`tsx` like the other scripts in `scripts/`).

- Reads `errors.rs`, extracts `(name, code, comment)` triples with a regex over
  the `pub enum Error { ... }` block; fails loudly on any line it cannot parse.
- Writes `packages/sdk/src/generated/contract-errors.ts`:

```ts
// AUTO-GENERATED from contracts/tariff-shield/src/errors.rs. Do not edit.
export enum ContractErrorCode { NotInitialized = 1, /* ... */ InsufficientSignatures = 22 }
export const CONTRACT_ERROR_MESSAGES: Record<ContractErrorCode, string> = { /* from comments/humanized names */ };
export function contractErrorFromCode(code: number): ContractErrorCode | undefined;
```

**SDK runtime:** add a `ContractError extends Error { code, name }` and a
`parseContractError(unknown): ContractError | null` that extracts `#N` from
`Error(Contract, #N)` in simulation errors and `resultXdr`/diagnostic events.
`simulate()` and `invokeAndSubmit*()` throw `ContractError` when a code is
found, and fall back to the current generic `Error` otherwise.

**API:** `stellar.ts`/routes import `ContractErrorCode` and switch on
`err.code`. The `#13` string match becomes `err.code === ContractErrorCode.RateLimitExceededError`.

**Web (optional follow-up):** `formatApiError` can consume the same map through
an API `code` field.

Alternative considered: a `build.rs`/proc-macro in the contract crate. Rejected:
it would tie TS output to `cargo build`, and Rust tooling would need to write
into a JS package.

## 3. CI verification

1. Add `npm run gen:errors --workspace=packages/sdk` and a `--check` mode that
   regenerates in memory and exits non-zero if the committed file differs.
2. Run `--check` in the existing SDK/contract CI job (path-filtered on
   `contracts/tariff-shield/src/errors.rs` and the generated file).
3. Add a stability test: a snapshot of `(name, code)` pairs. Changing or
   reusing an existing code must be an explicit snapshot edit, because codes
   are a public contract (see risks).
4. Unit test `parseContractError` against real strings such as
   `HostError: Error(Contract, #13)` and a diagnostic-event fixture.

## 4. Migration plan

1. Land the generator, generated file and `--check` in CI (no behavior change).
2. Add `ContractError` and `parseContractError` to the SDK; keep throwing
   `Error` subclasses so existing `catch` blocks still work (`ContractError extends Error`).
3. Replace the `importers.ts:1512` matcher with the typed check and add a test.
4. Audit the remaining API routes that call the SDK and add explicit mappings
   for user-actionable codes (`CollateralCapExceeded`, `NoDisputeWindow`,
   `DisputeAlreadyRaised`, `NoActiveDispute`, `AccountFrozen`, `StaleOracleError`) to 4xx responses instead of 500s.
5. Add a lint (`no-restricted-syntax` on string literals matching
   `/Error\(Contract/`) outside the SDK.

## 5. Trade-offs

**For:** removes hand-copied numeric codes; a new Rust variant is either
picked up automatically or fails CI; typed exhaustiveness in `switch`; users
get meaningful errors instead of a generic 500.

**Against:** a codegen step and a generated file in git; the parser depends on
`errors.rs` staying regular; `repr(u32)` values become a public API and can
never be renumbered or reused (already true on-chain, now enforced in CI);
messages derived from names/comments need a review pass for user-facing wording.
