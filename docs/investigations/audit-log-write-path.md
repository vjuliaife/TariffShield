# Investigation: admin/role-assignment write-path latency and the audit-log append

Issue: #1126

## Summary

This investigation measures the latency contribution of the append-only
`audit_log` write that accompanies admin/role-mutating requests, and confirms
two structural facts that shape the recommendation:

1. **There is no dedicated role-assignment endpoint** in
   `apps/api/src/routes/admin.ts` (routes end at `admin.ts:484+`: audit-log
   read, oracle alerts, roles read, bonds, etc. — none assigns a role). The only
   code that mutates the `role` column today is the SAML `surety_admin` upsert
   (`apps/api/src/routes/auth.ts:429-463`) and signup.
2. **The domain write and the audit entry are two separate statements on an
   autocommit pool**, i.e. two independent implicit transactions per request.
   `logAudit()` (`apps/api/src/db.ts`) is a single-`INSERT` side effect called
   after the domain write by every admin-style route (e.g.
   `routes/importers.ts:172,709,791,874,1197`, `routes/kyc.ts:173`) — never
   inside the same transaction as the domain change.

## What `audit_log` looks like

`audit_log` is append-only by design (`migrations/0004`, `db.ts:769-772`):
primary key + two btree indexes (`idx_audit_log_actor`, `idx_audit_log_action`),
RLS policies block `UPDATE`/`DELETE`. `logAudit()` is a bare
`INSERT INTO audit_log (actor_user_id, action, target_id, payload)`.

## Benchmark

`apps/api/tests/benchmarks/audit-log-write-path.js` — a local Postgres-only
harness (no HTTP, no Soroban) that:

- seeds a valid `users` actor, then measures a single `audit_log` INSERT at
  ~25k rows vs **~275k rows (11×)** — the shape of a role-change request
  already growing an audit trail;
- measures the **paired write pattern** (the SAML role upsert + audit insert) as
  two autocommit pool statements (today's behavior) vs the same pair inside one
  `BEGIN`/`COMMIT`.

Environment: docker compose Postgres 17 (`postgres:17-alpine`), defaults
(no tuning, not `synchronous_commit=off`). Run with
`node apps/api/tests/benchmarks/audit-log-write-path.js`.

Results (300 iterations each; representative run):

| Measurement                              | mean   | p50   | p95  |
| ---------------------------------------- | ------ | ----- | ---- |
| single `audit_log` INSERT @ ~25k rows    | 1.36ms | 1.32ms | 1.80ms |
| single `audit_log` INSERT @ ~275k rows   | 1.25ms | 1.23ms | 1.63ms |
| paired writes, **autocommit** (2 stmts)  | 2.69ms | 2.65ms | 3.38ms |
| paired writes, **single transaction**    | 2.53ms | 2.47ms | 3.36ms |

Run-to-run variance on this machine is ±20% between repetitions; the
size-scaling and single-`BEGIN` deltas below fall inside that band, so they
should be read as "no measurable effect" rather than as precise percentages.

## Findings

1. **The audit append itself is O(1) and does not scale with the table.** An
   11× growth in `audit_log` (25k → ~275k rows) leaves the single INSERT
   unchanged to within noise (≈1.2–1.4ms mean in every run; size is flat at
   ~40MB because the two btree indexes describe recent actors/actions, bounded
   by index depth rather than total count). `audit_log` does not need archiving
   for write *latency* reasons at this volume.

2. **The audit row is roughly half of the request's DB write latency, but that
   cost does not translate into a measurable win from transaction
   consolidation.** The audit INSERT is a second full round-trip built from the
   same pool — 44–63% of the autocommit pair in repeated runs. Wrapping the
   pair in one `BEGIN`/`COMMIT` removes one round-trip but measured only
   0.5–6% p50 improvement (a single host round-trip vs framing cost), i.e.
   within noise. The real reason to transact is **atomicity**, not latency: as
   two autocommit statements the writes are not atomic, and a failure between
   them leaves a domain change without its audit record (or vice versa) —
   which an append-only, RLS-locked compliance table must not tolerate.

3. **Structural gap:** there is no role-assignment endpoint whose latency could
   be benchmarked directly — the "role-change write" a contributor reaches for
   is the SAML upsert. If role assignment is added as a real admin endpoint, it
   should reuse the single-transaction pattern below.

## Recommendation

1. **Make the domain write + `logAudit` one transaction on every admin/mutation
   path.** Wrap the existing statement + `logAudit()` in `BEGIN`/`COMMIT` on a
   dedicated client (the pool already exposes `pool.connect()`). The benefit is
   **atomicity** — the audit record commits or rolls back with the domain
   change, which is the point of an append-only log. The latency delta is small
   (single round-trip removed; within noise on this host), so frame it as a
   correctness/compliance fix rather than a performance fix.
2. **Keep `logAudit` cheap and synchronous.** The append is flat per request
   (<2ms p95 even at 11× table size); no async/queue indirection is warranted
   until far larger volumes.
3. **If and when a real role-assignment endpoint is built**, model it on the
   pair above: single transaction, one `audit_log` row per assignment.

No code changes were made as part of this investigation; the benchmark harness
is committed for reproducibility.

## Acceptance criteria status

- [x] Benchmark admin/role write-path latency (audit append) at current data
      size — `audit-log-write-path.js`, 1x baseline above
- [x] Benchmark the same write at ~10× audit data size — flat within noise
      (1.2–1.4ms mean at both 1× and ~11×)
- [x] Identify the dominant cost component — the second round-trip (~half the
      pair latency), not the append itself
      (no transaction around domain write + audit row), not the append
- [x] Recommend a fix — single transaction around domain write + `logAudit()`
- [x] Reproducible harness — `node apps/api/tests/benchmarks/audit-log-write-path.js`