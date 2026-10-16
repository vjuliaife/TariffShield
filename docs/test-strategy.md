# Test Strategy

This document describes TariffShield's testing approach: which frameworks are used where, how tests are structured, what coverage targets apply, and how to run each test suite.

---

## Testing Philosophy

TariffShield spans three runtimes — Rust/Soroban, Node.js/Express, and Next.js — each with different testing needs:

1. **Contract unit tests first.** The Soroban contract holds funds on-chain and enforces invariants that cannot be patched after deployment. Every public entrypoint must have at least one test covering the happy path, every authorization boundary, and every error code. Contract tests run in a deterministic simulated Soroban environment with no network dependency.

2. **API integration tests second.** The Express API connects contract state, PostgreSQL, and business rules. Integration tests run against a real (Docker) PostgreSQL instance so that SQL queries and constraint violations are exercised as they would be in production. Mocking the database is avoided because mock/production divergence has caused silent breakage in the past. Coverage is currently minimal: `apps/api/src/__tests__/integration/bonds.test.ts` verifies a bond record insert and the `bond_type_code` check-constraint enforcement (issue #747). Auth boundaries, error paths, and happy-path HTTP routes are not yet covered — see "What to Test" below.

3. **SDK unit tests third.** The TypeScript SDK wraps Soroban RPC. Its unit tests mock the RPC layer to verify argument serialization, error mapping, and retry logic without requiring a live network.

4. **End-to-end tests for user-facing flows.** Playwright E2E tests validate critical importer and surety-admin journeys against the running Next.js frontend. These are confidence tests, not exhaustive coverage — they run on every deployment to staging.

---

## Test Categories

| Category | Location | Framework / Tooling | Status |
|----------|----------|---------------------|--------|
| Soroban contract unit tests | `contracts/tariff-shield/src/test.rs` | `cargo test` + `soroban-sdk` testutils | Active (42 tests) |
| API integration tests | `apps/api/src/__tests__/` | supertest + Jest or Vitest (to be added) | Active — minimal (2 tests in `bonds.test.ts`) |
| SDK compatibility tests | `packages/sdk/src/compatibility.test.ts` | `tsx --test` (Node built-in test runner) | Active — run with `npm run test --workspace=packages/sdk` |
| Web unit tests | `apps/web/components/**/*.test.tsx`, `apps/web/lib/**/*.test.ts` | Vitest + Testing Library (jsdom per file) | Active — run with `npm test --workspace=apps/web` |
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
| `apps/web` (unit) | Vitest | Vitest `expect` / `node:assert/strict` | None — components rendered with Testing Library in jsdom | N/A | `@vitest/coverage-v8` (text + html) |
| `apps/web` (e2e) | Playwright v1.49 | Playwright assertions | Real API on localhost | N/A | Playwright trace files |

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

### Web unit tests (Vitest)
```bash
# From apps/web/
npm test                # vitest run — component and lib unit tests, single pass
npm run test:watch      # vitest in watch mode
npm run test:coverage   # vitest run --coverage — fails if coverage drops below the thresholds

# Equivalent (from repo root)
npm test --workspace=apps/web
```

`apps/web/vitest.config.ts` only collects `components/**/*.test.{ts,tsx}` and `lib/**/*.test.{ts,tsx}` and explicitly excludes `e2e/`, so it never picks up Playwright specs. Component tests opt into a DOM with a `// @vitest-environment jsdom` docblock; everything else runs in Node.

The `@/` import alias is derived from `compilerOptions.paths["@/*"]` in `apps/web/tsconfig.json` rather than duplicated, so Vitest, `tsc` and Next.js always resolve `@/lib/...` and `@/components/...` to the same files. `lib/vitest-config.test.ts` fails if the two ever drift.

Coverage thresholds (lines/statements/branches/functions) live in `vitest.config.ts` `test.coverage.thresholds`. They start at a low baseline for the new suite — raise them in the same PR that adds tests.

### E2E tests
```bash
# From apps/web/
npm run test:e2e

# With trace on failure (CI mode)
npx playwright test --reporter=html
```

`apps/web/playwright.config.ts` sets `testDir: './e2e'`, so Playwright never runs Vitest files. Neither runner starts a server or binds a port (Playwright targets `PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`, which you start yourself), so `npm test && npm run test:e2e` can run back to back in one shell.

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

# Web unit tests (after npm run test:coverage in apps/web)
open apps/web/coverage/index.html

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
