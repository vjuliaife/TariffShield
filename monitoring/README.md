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

## Metrics & Dashboards

- **Prometheus:** Scrapes metrics from `/metrics` on the API.
- **Grafana:** Visualizes API performance, error rates, and Soroban health.
This directory contains Prometheus alert rules, Grafana dashboards, and runbooks.

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

| Metric | Type | Labels | Description |
|---|---|---|---|
| `db_query_duration_seconds` | Histogram | `query_name` | Query latency distribution |
| `db_slow_queries_total` | Counter | `threshold` (`500ms` / `2000ms`) | Count of slow queries |

### Slow query log fields

Queries taking ≥500ms emit a Pino `warn` with:

```json
{ "query": "<sanitized SQL>", "durationMs": 612, "rowCount": 1, "caller": "select_importers" }
```

Queries taking ≥2000ms emit a Pino `error`.

### Alert rules

`monitoring/prometheus/alerts/database.yml` defines:

- **DbSlowQueryRateHigh** — fires when the 500ms slow query rate > 1/s for 3 minutes (warning)
- **DbCriticalSlowQuery** — fires immediately on any ≥2s query (critical)

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
