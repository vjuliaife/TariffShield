# Test Strategy

This document describes TariffShield's testing approach: which frameworks are used where, how tests are structured, what coverage targets apply, and how to run each test suite.

---

## Testing Philosophy

TariffShield spans three runtimes — Rust/Soroban, Node.js/Express, and Next.js — each with different testing needs:

1. **Contract unit tests first.** The Soroban contract holds funds on-chain and enforces invariants that cannot be patched after deployment. Every public entrypoint must have at least one test covering the happy path, every authorization boundary, and every error code. Contract tests run in a deterministic simulated Soroban environment with no network dependency.

2. **API integration tests second.** The Express API connects contract state, PostgreSQL, and business rules. Database-backed integration tests run against a real (Docker) PostgreSQL instance so that SQL queries and constraint violations are exercised as they would be in production. Mocking the database is avoided because mock/production divergence has caused silent breakage in the past. Route coverage includes health probes and KYC upload authorization, alongside the database integration cases — see "What to Test" below.

3. **SDK unit tests third.** The TypeScript SDK wraps Soroban RPC. Its unit tests mock the RPC layer to verify argument serialization, error mapping, and retry logic without requiring a live network.

4. **End-to-end tests for user-facing flows.** Playwright E2E tests validate critical importer and surety-admin journeys against the running Next.js frontend. These are confidence tests, not exhaustive coverage — they run on every deployment to staging.

---

## Test Categories

| Category | Location | Framework / Tooling | Status |
|----------|----------|---------------------|--------|
| Soroban contract unit tests | `contracts/tariff-shield/src/test.rs` | `cargo test` + `soroban-sdk` testutils | Active (42 tests) |
| API integration tests | `apps/api/src/__tests__/` | supertest + Jest or Vitest (to be added) | Active — minimal (2 tests in `bonds.test.ts`) |
| SDK compatibility tests | `packages/sdk/src/compatibility.test.ts` | `tsx --test` (Node built-in test runner) | Active — run with `npm run test --workspace=packages/sdk` |
| E2E tests | `apps/web/e2e/` | Playwright v1.49, Desktop Chrome | Active (3 specs) |

> **Keeping the contract test count accurate:** the "(N tests)" figure above is a snapshot, not a generated value, so it drifts whenever `test.rs` gains or loses `#[test]` functions. Verify it before relying on it:
> ```bash
> grep -c '#\[test\]' contracts/tariff-shield/src/test.rs
> ```
> CI check idea: add a lightweight step (e.g. to `lint` or a new `docs-check` job) that runs the grep above and fails the build if the count doesn't match the number recorded in this file, so a stale count is caught at PR time instead of by manual audit.

---

## Frameworks and Tools

| Package | Testing Framework | Assertion Library | HTTP / RPC Mock | DB Strategy | Coverage Tool |
|---------|------------------|-------------------|-----------------|-------------|---------------|
| `contracts/tariff-shield` | `cargo test` | Rust `assert_eq!` / `assert!` | Soroban test env (in-process simulation) | N/A | `cargo llvm-cov` (not yet configured) |
| `apps/api` | `node:test` (built-in) | `node:assert/strict` | None — direct `pg` `Pool` queries, no HTTP layer | Docker PostgreSQL (matches production schema) | Not yet configured |
| `packages/sdk` | `tsx --test` (Node built-in test runner) | Node built-in `assert` | N/A — compatibility tests exercise version detection logic | N/A | Not yet configured |
| `apps/web` | Playwright v1.49 | Playwright assertions | Real API on localhost | N/A | Playwright trace files |

---

## Coverage Targets

| Scope | Minimum Target | Rationale |
|-------|---------------|-----------|
| Contract public entrypoints | 100% of functions | Each entrypoint manages on-chain funds; untested paths are unacceptable risk |
| API routes (line coverage) | ≥ 80% | Covers happy paths and the most common error paths; remaining gaps documented |
| SDK public methods (line coverage) | ≥ 90% | SDK is the primary integration surface; near-complete coverage catches serialization bugs |
| E2E user journeys | Core flows covered | Sign-up → register, deposit flow, surety clawback |

---

## How to Run Tests

### Contract unit tests
```bash
# From repo root
npm run contract:test

# Equivalent (from contracts/ directory)
cargo test --manifest-path contracts/tariff-shield/Cargo.toml
```

### E2E tests
```bash
# From apps/web/
npm run test:e2e

# With trace on failure (CI mode)
npx playwright test --reporter=html
```

### API integration tests
```bash
# From apps/api/ — requires Docker PostgreSQL running and migrations applied
npm run test:integration

# Equivalent (from repo root)
npm run test:integration --workspace=apps/api
```

### SDK tests
```bash
# From repo root
npm run test --workspace=packages/sdk

# Equivalent (from packages/sdk/)
npm test
```

### View coverage report
After running tests with coverage:
```bash
# API / SDK
open coverage/index.html

# Playwright report
open apps/web/playwright-report/index.html
```

---

## What to Test

### Soroban contract (`contracts/tariff-shield/src/test.rs`)

- **Authorization boundaries:** every entrypoint that calls `require_auth()` must have a test that passes a wrong signer and asserts the expected `Error(Auth, ...)` panic.
- **Arithmetic invariants:** collateral balance never goes negative; `auto_top_up` never moves more than the reserve balance; `withdraw_collateral` never takes below `required_collateral`.
- **Rate limiting:** `set_required_collateral` called twice within 24 ledger hours must return `Error(Contract, #13)`.
- **Dispute window:** `raise_dispute` after `dispute_expires_at` must fail; `resolve_dispute` with `accept = false` must restore `pre_dispute_required`.
- **Collateral history:** after 13 oracle updates, the history vec contains exactly 12 entries (oldest is evicted).
- **Already initialized:** calling `initialize` twice must fail.

### API routes (`apps/api/src/__tests__/`)

- **Auth boundaries:** every route that requires a role must return `403` when called with the wrong role; every protected route must return `401` when called without a token.
- **Input validation:** send bodies with missing required fields, wrong types, and values outside the allowed enum; expect `400`.
- **Error paths:** importer not found (`404`), email conflict (`409`), OFAC hit (`403`), KYC gating (`403`), CBP deviation (`422`).
- **Happy paths:** successful signup + login, register importer, deposit collateral, upload tariff CSV.
- **Health probes:** `/health/live` stays 200 plain-text `OK` without calling dependencies; `/health/ready` returns plain-text `503 Service Unavailable` when any DB, Soroban, or Redis ping fails, and `200 OK` when all succeed.
- **KYC uploads:** a surety-admin upload is rejected with 403 and inserts no row; an importer can upload to their own importer id, but receives 404 for another importer's id.
- **Deposit KYC gate:** `POST /importers/:id/deposit` returns 403 with `kycStatus` in the body when `kyc_status` is `pending` or `rejected`; upgrading to `approved` allows the same request to succeed with 202 and a `jobId`; AML wallet screening is independently enforced after the KYC gate passes (HIGH-risk address → 403 even when KYC is approved). Covered by `feature-593-deposit-kyc-gate.test.ts`.
- **Oracle reconciliation:** `POST /importers/:id/verify-oracle-data` returns `match: false` and inserts a `reconciliation_failure` row in `oracle_alerts` when computed required collateral deviates > 1% from the on-chain value; returns `match: true` with no alert row when deviation is ≤ 1%; returns 404 when the importer has no `tariff_uploads` row; `as_of_date` body param selects the most-recent upload at or before that timestamp. Covered by `feature-594-verify-oracle-data.test.ts`.
- **BullMQ job state transitions:** `GET /importers/:id/tx-status/:jobId` returns 200 with `state: 'completed'` and `result` (the job's returnvalue) for completed jobs; returns 400 with `state: 'failed'` and `error` (the job's failedReason) for failed jobs; returns 200 with `state` and `progress` for active or waiting jobs; returns 404 `'job not found'` when the jobId does not exist for a valid importer; returns 404 `'not found'` for an invalid or unauthorized importer. Covered by `feature-595-tx-status-job-states.test.ts`.
- **Rate limit mapping:** when the contract client throws an error containing `Error(Contract, #13)`, the route must respond `429` with `Retry-After`.

### SDK methods (`packages/sdk/src/__tests__/`)

- **Argument serialization:** verify that `BigInt` amounts are encoded as `i128` ScVals and addresses as `Address` ScVals.
- **Timeout behaviour:** mock `getTransaction` to always return `NOT_FOUND` and verify that `invokeAndSubmit` throws after 60 seconds.
- **Error mapping:** mock `sendTransaction` to return `status: "ERROR"` and verify that the thrown error message contains the errorResult.
- **Read methods:** mock `simulateTransaction` and verify that `getAccount` correctly deserializes every field of the `Account` struct.

---

## CI Integration

Tests are executed by GitHub Actions (`.github/workflows/ci.yml`):

| CI Job | Trigger | Blocks PR merge |
|--------|---------|-----------------|
| `test` | Every PR and push to `main` | Yes — runs `npm run contract:test` (Rust contract) |
| `typecheck` | Every PR and push to `main` | Yes — runs `tsc --noEmit` on `apps/web` |
| `lint` | Every PR and push to `main` | Yes — runs `next lint` on `apps/web` |
| `audit` | Every PR and push to `main` | Yes — `npm audit --audit-level=high` |
| `api-integration` | Every PR and push to `main` | Yes — runs `npm run test:integration --workspace=apps/api` against real minimal tests (issue #747) |
| E2E (`e2e.yml`) | On Vercel deployment status event | No — informational on staging |

**Policy:** a PR may not merge if `test`, `typecheck`, `lint`, `audit`, or `api-integration` fail. `.github/protection.json` already lists `CI / api-integration` as a required status check, so it is blocking today, not pending a future milestone — the coverage behind it is simply still minimal (see "Testing Philosophy" and "What to Test" above).

Tests that require secrets (Stellar keys, database) use GitHub Actions environment secrets and do not run on fork PRs from external contributors unless a maintainer approves the workflow run.
