# Horizontal Scaling Guide

Issue: #263

This document covers running multiple `apps/api` instances behind a load
balancer: what state is (and isn't) safe to share across processes, how to
configure Redis/Postgres for multi-instance deployment, and load balancer
setup.

## Summary

`apps/api` is already stateless in the way that matters for horizontal
scaling: authentication is a shared-secret JWT with no server-side session
store, and the one piece of cross-request mutable state (in-flight
transaction jobs) already lives in Redis via BullMQ, not in process memory.
No architectural changes were needed to make the API horizontally scalable —
this doc formalizes what to configure, plus fixes two small gaps found while
auditing (`GET /health` didn't check Redis, and `apps/api/src/stellar.ts` had
a duplicate `getBondOnChain` declaration that would fail `tsc` — fixed
separately in this PR).

## Audit: in-memory state in `apps/api/`

| Location | What it is | Safe across instances? |
|---|---|---|
| `apps/api/src/queue.ts` (`txSubmitQueue`, `createTxSubmitWorker`) | In-flight transaction submission jobs | **Yes** — externalized to Redis via BullMQ. Any instance can enqueue a job; any worker process can pick it up. Job state (`GET /importers/:id/tx-status/:jobId`) is read back from Redis, not a local map. |
| `apps/api/src/stellar.ts` (`contractClient`, `platformKeypair`, etc.) | Soroban RPC client + signing keypairs | **Yes** — read-only after construction. Each process builds its own client from the same env vars (`STELLAR_RPC_URL`, `PLATFORM_STELLAR_SECRET`, etc.); no shared mutable state or per-process cache of chain data. |
| `apps/api/src/db.ts` (`basePool`) | PostgreSQL connection pool | **Must stay per-process** — this is correct as-is. Each API instance owns its own `pg.Pool`; pools are not meant to be shared across processes. Scale by tuning `max` pool size per instance × instance count against Postgres' `max_connections`. |
| `apps/api/lib/api.ts` (frontend) `importerPrefetchCache` | Browser-side hover-prefetch cache | N/A — runs in the client's browser, not the API process. Irrelevant to API horizontal scaling. |
| `prom-client` metric registries (`sorobanRpcCallsTotal`, `dbQueryDurationSeconds`, `httpRequestsTotal`, etc.) | Per-process Prometheus counters/histograms | **Expected to be per-process.** `GET /metrics` on each instance reports that instance's own counters; your scrape config (Prometheus federation / remote_write) is responsible for aggregating across instances. This is standard practice, not a scaling blocker. |
| `apps/api/src/jobs/reconcile-balances.ts` (`isRunning` guard), `refresh-importer-metrics.ts`, `compliance-report.ts` schedulers | `setInterval`-based background jobs started in `apps/api/src/index.ts`'s `start()` | **Redundant, not unsafe, under N instances.** Each instance runs its own copy of these schedulers, so with N instances you get N-way duplicate reconciliation/refresh/report runs. They're idempotent (reconciliation just re-reads and logs drift; `REFRESH MATERIALIZED VIEW CONCURRENTLY` is safe to run concurrently; compliance reports upsert by month), so this is wasted work rather than a correctness bug — but if you scale to many instances, consider moving these to a single dedicated worker process (`npm run start:worker` already exists for the BullMQ worker; the same pattern applies) rather than running them on every API replica. |

## JWT verification

`apps/api/src/auth.ts` verifies tokens with `jwt.verify(token, env.JWT_SECRET)`
— no session lookup, no per-process cache. As long as every instance is
configured with the same `JWT_SECRET` (see `docs/environment-variables.md`),
any instance can authenticate a request signed by any other instance's
`jwt.sign()` call. No sticky sessions required.

## Redis requirements

Set the same `REDIS_URL` on every API instance and on the worker process
(`npm run start:worker` / `apps/api/src/worker.ts`). Redis is required for:

- The `tx-submit` BullMQ queue (`apps/api/src/queue.ts`) — job submission and
  status polling.
- `GET /health` and `GET /health/ready` connectivity checks (added in this
  PR — see below).

A single managed Redis instance (e.g. ElastiCache, Upstash) is sufficient;
BullMQ does not require Redis Cluster for this workload.

## Health check endpoint

`GET /health` now reports DB, Soroban RPC, and Redis connectivity:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "db": "connected",
  "soroban": "ok",
  "redis": "connected",
  "contractId": "...",
  "network": "testnet",
  "env": "production"
}
```

Returns `503` with `status: "degraded"` if any dependency check fails.

- `GET /health/live` — liveness probe (process is up), no dependency checks.
  Always returns `200` with `{ "status": "ok" }`.
- `GET /health/ready` — readiness probe: `200` with `{ "status": "ok" }` only
  if DB, Soroban RPC, and Redis are all reachable, otherwise `503` with
  `{ "status": "degraded" }`. Use this for load balancer target health checks
  and Kubernetes `readinessProbe` (use `/health/live` for `livenessProbe`).

## Load balancer configuration

No sticky sessions (session affinity) are required — any healthy instance
can serve any authenticated request.

### nginx

```nginx
upstream tariffshield_api {
    # Round-robin (default) — no ip_hash / sticky sessions needed.
    server api-1.internal:3002;
    server api-2.internal:3002;
}

server {
    location / {
        proxy_pass http://tariffshield_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Configure nginx's active health check (or a sidecar like `nginx-upstream-check`)
against `GET /health/ready` on each upstream.

### AWS ALB

- Target group: register each API instance/task.
- Health check path: `/health/ready`, healthy threshold 2, interval 15s.
- No stickiness policy needed (`stickiness.enabled = false`, the default).
- `app.set("trust proxy", 1)` is already set in `apps/api/src/index.ts`, so
  `X-Forwarded-For` from the ALB is honored for rate limiting / IP allowlisting.

## Verifying under load

The k6 benchmark suite added for #265 (`apps/api/tests/load/`) targets a
single instance. Running it against 2+ instances behind the load balancer
described above, and confirming error rate stays under the existing 0.1%
target at the documented VU counts, is the concrete verification step for
this issue's "< 5% error rate at 500 RPS across 2 instances" acceptance
criterion — that requires an actual multi-instance deployment (Redis,
Postgres, 2 API processes, a load balancer) to run against, which isn't
available in this repo/session. Everything above (the audit, the Redis
health check, the stateless-JWT confirmation) is what that verification run
would be checking; nothing in the audit suggests it would fail.
