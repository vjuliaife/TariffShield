# k6 Load Tests

Issue: #265

Load/benchmark suite covering the `apps/api` importer routes, establishing a
reproducible performance baseline.

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed locally (or use the `grafana/k6` Docker image).
- The API running and reachable (`npm run dev:api` from the repo root, or a deployed staging environment).
- A seeded database — each script's `setup()` signs up a fresh importer and
  registers it on-chain (real Stellar testnet calls), so no separate seed
  step is required to _run_ the scripts, but see the KYC note below for the
  deposit script specifically.

## Endpoints covered

| Script                   | Route                             | p95 target | Error rate target |
| ------------------------ | --------------------------------- | ---------- | ----------------- |
| `get-importers.js`       | `GET /importers`                  | < 200ms    | < 0.1%            |
| `get-importer-detail.js` | `GET /importers/:id`              | < 150ms    | < 0.1%            |
| `post-deposit.js`        | `POST /importers/:id/deposit`     | < 500ms    | < 0.1%            |
| `post-withdraw.js`       | `POST /importers/:id/withdraw`    | < 500ms    | < 0.1%            |
| `post-auto-top-up.js`    | `POST /importers/:id/auto-top-up` | < 500ms    | < 0.1%            |

All targets are measured at 50 concurrent virtual users (`vus: 50`) over a
1-minute run. Each script's `thresholds` block enforces these targets
directly — k6 exits with a non-zero status code if a threshold is breached,
which is what makes this suitable as a CI gate.

Note: the issue that requested this suite referred to a `POST
/admin/auto-top-up` route. No such route exists in this codebase — the real
route is `POST /importers/:id/auto-top-up` (see
`apps/api/src/routes/importers.ts`), and that's what `post-auto-top-up.js`
targets.

## Concurrent deposit_collateral investigation (#1089)

`post-deposit-concurrency.js` is a separate script, not part of the
`npm run benchmark` suite above. Instead of hitting one importer at constant
load, it registers a fresh importer per virtual user and ramps concurrency
from 1 to 100 VUs in stages, so it exercises `deposit_collateral` submitted
concurrently across many distinct on-chain accounts — the scenario
investigated in
[`docs/investigations/deposit-collateral-throughput.md`](../../../../docs/investigations/deposit-collateral-throughput.md).
Run it directly:

```bash
API_BASE_URL=http://localhost:3002 k6 run tests/load/post-deposit-concurrency.js
```

## Running

```bash
# from apps/api/
npm run benchmark

# or target a different environment
API_BASE_URL=https://staging.tariffshield.example npm run benchmark

# or run a single script directly
API_BASE_URL=http://localhost:3002 k6 run tests/load/get-importers.js
```

`npm run benchmark` runs all five scripts sequentially and writes a JSON
summary per script to `tests/load/results/` (gitignored). It exits non-zero
if any script's thresholds failed.

## Known limitation: KYC-gated deposit

`POST /importers/:id/deposit` returns `403` until the importer's
`kyc_status` is `'approved'`, which requires a document-upload +
`surety_admin` review flow (`apps/api/src/routes/kyc.ts`) that this
suite's `setup()` does not automate. `post-deposit.js` accepts both `202`
(job enqueued) and `403` (KYC gate) as non-error responses so the
benchmark still measures real endpoint latency/error-rate under load; to
exercise the actual deposit-success path, seed an approved importer in
your staging environment first (via the KYC review flow, or a direct
`UPDATE importers SET kyc_status = 'approved'` in a non-production DB) and
point a script at that importer's id instead of registering a fresh one.

## Baseline numbers

This suite establishes the _harness_ and the _targets_ (documented above,
matching the issue's acceptance criteria). Actual baseline p95/error-rate
numbers need to be captured by running it against a real staging
deployment — that requires a live Postgres + Redis + Stellar-testnet-backed
API instance, which isn't available in the environment this suite was
authored in. The CI workflow (`.github/workflows/benchmark.yml`) runs this
suite on every PR against a seeded staging DB and posts the results as a PR
comment, which is where ongoing baseline numbers should be tracked from.
