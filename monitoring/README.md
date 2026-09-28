# TariffShield Monitoring

This directory contains configuration for TariffShield metrics, logging, and uptime monitoring.

## Uptime Monitoring

We use [Better Uptime](https://betteruptime.com) to track the availability of our services.

- **Status Page:** [https://status.tariffshield.com](https://status.tariffshield.com)
- **API Health Endpoint:** `https://api.tariffshield.com/health`
- **Web App Root:** `https://app.tariffshield.com/`

### Incident Acknowledgement

When an alert is fired:

1. **Email/SMS:** Click the "Acknowledge" link in the notification.
2. **Dashboard:** Go to the Better Uptime incidents page and click "Acknowledge" on the active incident.
3. **PagerDuty/Slack:** Use the integration buttons provided in the respective channels.

Acknowledging an incident stops further escalations (e.g., prevents the "down for 5 minutes" SMS/Call if already being handled).

## Health Checks

The API exports three health check endpoints:

- `/health`: Comprehensive check of process + database + Soroban RPC.
- `/health/ready`: Readiness probe for deployment gates (Kubernetes/Render).
- `/health/live`: Liveness probe (process heart-beat).

All health endpoints return JSON with a `status` field (`"ok"` on 200,
`"degraded"` on 503), so monitors can assert on either the status code or
the body.

## Prometheus Alert Routing

### Alertmanager configuration

Alertmanager configuration lives **outside this repository** in the infrastructure
deployment repo. It consumes the rules from `monitoring/prometheus/alerts/` and routes
them to notification channels based on label values. Contact the infrastructure team
or check the internal Terraform/Helm configs for the active Alertmanager config file.

### Label conventions

All alert rules must carry the following labels so Alertmanager can route them
to the correct receiver:

| Label      | Required values                | Purpose                                               |
| ---------- | ------------------------------ | ----------------------------------------------------- |
| `severity` | `critical` or `warning`        | Governs escalation urgency                            |
| `team`     | `backend` (all current alerts) | Routes to the team's Slack channel / on-call rotation |

### Severity → notification channel mapping

| Severity   | Slack channel      | PagerDuty escalation                         | Notes                              |
| ---------- | ------------------ | -------------------------------------------- | ---------------------------------- |
| `critical` | `#alerts-critical` | Yes — pages the on-call engineer immediately | Expect a response within 5 minutes |
| `warning`  | `#alerts-warning`  | No — notification only                       | Investigate within the working day |

### Alert inventory

| Alert                          | File                                   | Severity | Team                 | Runbook                                       | Notification                   |
| ------------------------------ | -------------------------------------- | -------- | -------------------- | --------------------------------------------- | ------------------------------ |
| `ContractEventIndexerHighLag`  | `prometheus/alerts/indexer.yml`        | critical | _(unset — see note)_ | [indexer-lag.md](runbooks/indexer-lag.md)     | `#alerts-critical` + PagerDuty |
| `ContractEventIndexerStalled`  | `prometheus/alerts/indexer.yml`        | critical | _(unset — see note)_ | [indexer-lag.md](runbooks/indexer-lag.md)     | `#alerts-critical` + PagerDuty |
| `ContractBalanceDriftDetected` | `prometheus/alerts/reconciliation.yml` | critical | backend              | [balance-drift.md](runbooks/balance-drift.md) | `#alerts-critical` + PagerDuty |
| `ReconciliationJobNotRunning`  | `prometheus/alerts/reconciliation.yml` | critical | backend              | [balance-drift.md](runbooks/balance-drift.md) | `#alerts-critical` + PagerDuty |
| `DbSlowQueryRateHigh`          | `prometheus/alerts/database.yml`       | warning  | backend              | _(none)_                                      | `#alerts-warning` only         |
| `DbCriticalSlowQuery`          | `prometheus/alerts/database.yml`       | critical | backend              | _(none)_                                      | `#alerts-critical` + PagerDuty |

> **Gap:** `ContractEventIndexerHighLag` and `ContractEventIndexerStalled` are missing
> the `team: backend` label. Until that label is added, Alertmanager cannot route them
> to the backend team's receiver — they will fall through to the default receiver (if any).
> See issue #763 / #762.

## Metrics & Dashboards

- **Prometheus:** Scrapes metrics from `/metrics` on the API.
- **Grafana:** Visualizes API performance, error rates, and Soroban health via [tariffshield-api.json](grafana/dashboards/tariffshield-api.json).

  The dashboard has been verified to contain the following panels (re-verified panel count: 8):
  - **Contract Event Indexer Lag** (initially the single panel on the dashboard)
  - **HTTP Request Rate by Route** (added via issue #754)
  - **HTTP 5xx Error Rate** (added via issue #754)
  - **HTTP Request Latency (p95/p99) by Route** (added via issue #755)
  - **Soroban RPC Call Rate by Success** (added via issue #756)
  - **Soroban RPC Latency (p95) by Method** (added via issue #756)
  - **PostgreSQL Connection Pool** (added via issue #757)
  - **PostgreSQL Pool Events by Type** (added via issue #757)

This directory contains Prometheus alert rules, Grafana dashboards, and runbooks.

### Importing and Provisioning the Grafana Dashboard

The API metrics dashboard configuration is stored in [tariffshield-api.json]. It references a Prometheus datasource via the `${DS_PROMETHEUS}` variable.

#### Option 1: Manual Import via the Grafana UI
1. Navigate to **Dashboards** > **New** > **Import** in the Grafana UI.
2. Upload the `tariffshield-api.json` file or paste its JSON content.
3. Grafana will detect the `__inputs` requirement for `DS_PROMETHEUS` and prompt you to select an active Prometheus datasource from a dropdown menu.
4. Click **Import** to load the dashboard.

#### Option 2: Automated Provisioning
1. Mount the dashboard JSON file into the Grafana container (e.g. at `/var/lib/grafana/dashboards/tariffshield-api.json`).
2. Add a provisioning configuration file in Grafana (e.g. `/etc/grafana/provisioning/dashboards/tariffshield.yaml`):
   ```yaml
   apiVersion: 1
   providers:
     - name: 'TariffShield'
       orgId: 1
       folder: ''
       type: file
       disableDeletion: false
       editable: true
       options:
         path: /var/lib/grafana/dashboards
   ```
3. Grafana will automatically resolve the templating datasource variable `DS_PROMETHEUS` at startup to your active Prometheus datasource.

## Alert Label Convention

All Prometheus alert rules must include a `team` label so Alertmanager can route
alerts to the correct on-call receiver. Without it, alerts fall through to the
default route instead of paging the responsible team.

**Convention:** every alert in `monitoring/prometheus/alerts/*.yml` must carry
`team: backend` unless a more specific team label is appropriate.

```yaml
labels:
  severity: critical
  team: backend   # required on every alert rule
```

This matches the convention established in `database.yml` and is now applied to
`indexer.yml` and `reconciliation.yml` as well. When adding a new alert file, ensure
its rules include this label before merging.

---

## OpenTelemetry Distributed Tracing (issue #368)

TariffShield uses OpenTelemetry to emit traces from each HTTP request through the Express handler, PostgreSQL queries, and Soroban RPC calls. Traces are exported via OTLP/HTTP to a local Jaeger instance during development.

### Start Jaeger locally

Jaeger is included in `docker-compose.yml` as the `jaeger` service:

```bash
docker-compose up -d jaeger
```

The Jaeger UI is then available at **http://localhost:16686**.

The OTLP HTTP collector listens on **port 4318** (the default for `OTEL_EXPORTER_OTLP_ENDPOINT`).

### Trigger a trace

Start the API with Jaeger running:

```bash
# Ensure OTEL_EXPORTER_OTLP_ENDPOINT is set (default is http://localhost:4318)
make dev    # or: cd apps/api && npm run dev
```

Make any API call, e.g.:

```bash
curl http://localhost:3002/health
curl -X POST http://localhost:3002/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"devpassword"}'
```

### View traces in Jaeger

1. Open http://localhost:16686
2. Select **Service** → `tariffshield-api`
3. Click **Find Traces**
4. Click any trace to see the full span tree: HTTP → Express handler → `pg` query spans → Soroban RPC spans

Each Soroban RPC span is named `soroban.rpc.<methodName>` and carries attributes:

- `soroban.method` — the contract method name
- `soroban.network` — the Stellar network passphrase

### Correlate traces with Pino logs

The `traceId` and `spanId` are automatically injected into Pino log records via OpenTelemetry's context propagation. Look for `trace_id` in structured log output:

```json
{
  "level": "warn",
  "query": "SELECT last_processed_ledger FROM ...",
  "durationMs": 612,
  "trace_id": "abc123...",
  "span_id": "def456..."
}
```

---

## Database Query Performance (issue #373)

### Prometheus metrics

| Metric                      | Type      | Labels                           | Description                                          |
| --------------------------- | --------- | -------------------------------- | ---------------------------------------------------- |
| `db_query_duration_seconds` | Histogram | `query_name`                     | Query latency distribution                           |
| `db_slow_queries_total`     | Counter   | `threshold` (`500ms` / `2000ms`) | Count of slow queries                                |
| `pg_pool_active`            | Gauge     | —                                | PostgreSQL pool clients currently checked out        |
| `pg_pool_idle`              | Gauge     | —                                | Idle PostgreSQL pool clients available for reuse     |
| `pg_pool_waiting`           | Gauge     | —                                | Queued requests waiting for a PostgreSQL pool client |

### Slow query log fields

Queries taking ≥500ms emit a Pino `warn` with:

```json
{ "query": "<sanitized SQL>", "durationMs": 612, "rowCount": 1, "caller": "select_importers" }
```

Queries taking ≥2000ms emit a Pino `error`.

### Alert rules

`monitoring/prometheus/alerts/database.yml` defines:

- **DbSlowQueryRateHigh** — fires when the 500ms slow query rate > 1/s for 3 minutes (warning). See monitoring/runbooks/database-slow-queries.md.
- **DbCriticalSlowQuery** — fires immediately on any ≥2s query (critical). See monitoring/runbooks/database-slow-queries.md.
- **PgPoolExhaustion** (issue #760) — fires when more than 5 requests have waited for a pool client for over 10 seconds (warning). Mirrors the in-process log-only check already in `apps/api/src/db.ts`. See monitoring/runbooks/pg-pool-exhaustion.md.

### Top 10 slowest queries via pg_stat_statements

The `pg_stat_statements` extension is enabled by the migration. To query it:

```sql
SELECT
  query,
  calls,
  total_exec_time,
  mean_exec_time,
  rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Connect to the dev Postgres instance:

```bash
docker-compose exec postgres psql -U tariffshield -d tariffshield
```

To reset the statistics:

```sql
SELECT pg_stat_statements_reset();
```

## Importer Metrics Refresh (issue #761)

`monitoring/prometheus/alerts/importer-metrics.yml` defines:

- **ImporterMetricsRefreshJobNotRunning** — fires when no `importer_metrics_mv` refresh attempts have run in 15 minutes (critical)
- **ImporterMetricsRefreshJobFailing** — fires when refresh attempts have been failing for 10 minutes (warning)

See `monitoring/runbooks/importer-metrics-refresh.md` for the response procedure.

---

## HTTP Request Metrics (issue #758, #759)

### Prometheus metrics

| Metric                          | Type      | Labels                           | Description                       |
| ------------------------------- | --------- | -------------------------------- | --------------------------------- |
| `http_requests_total`           | Counter   | `method`, `route`, `status_code` | Total HTTP requests processed     |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | HTTP request latency distribution |

### Alert rules

`monitoring/prometheus/alerts/http.yml` defines:

- **HttpServerErrorRateHigh** — fires when the HTTP 5xx rate exceeds 0.05/s for 5 minutes (warning). See monitoring/runbooks/http-errors.md.
- **HttpRequestLatencyHighP95** — fires when p95 request latency exceeds 1s for 5 minutes (warning). See monitoring/runbooks/http-latency.md.
