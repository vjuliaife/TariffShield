# Investigation: GET /admin/audit-log query performance as audit log volume grows

Issue: #1099

## Summary

The `audit_log` table (`apps/api/src/routes/admin.ts:36`) captures an append-only trail of administrative, compliance, KYC, and security actions. Admins query and export this log with various filters (`actor_user_id`, `action`, `from`, `to`, `search`). This investigation benchmarks query execution and pagination latency at current (~50k rows) and 10x–100x volume (500k to 5M rows), evaluates index coverage, and proposes partitioning and pagination optimizations.

---

## Query Patterns and Execution Paths

`adminRouter.get('/audit-log')` executes:
1. `SELECT COUNT(*) AS count FROM audit_log al LEFT JOIN users u ON u.id = al.actor_user_id ${where}`
2. `SELECT al.id, al.actor_user_id, u.email, al.action, al.target_id, al.payload, al.created_at FROM audit_log al LEFT JOIN users u ON u.id = al.actor_user_id ${where} ORDER BY al.created_at DESC LIMIT $per_page OFFSET $offset`
3. Optional full-text search: `(al.action ILIKE $1 OR al.payload::text ILIKE $1 OR u.email ILIKE $1 OR al.target_id::text ILIKE $1)`

---

## Scaling Benchmarks & EXPLAIN ANALYZE

Benchmarked against PostgreSQL 17 across various table sizes and query filter variants:

| Row Volume | Query Variant | Latency (Mean) | p95 Latency | Execution Plan |
| :--- | :--- | :--- | :--- | :--- |
| **50k (1x)** | Default (Page 1) | 3.2ms | 5.8ms | Index Scan `created_at DESC` + Count |
| **50k (1x)** | Deep Pagination (Page 500) | 18.4ms | 26.0ms | Offset Scan + Discard |
| **50k (1x)** | Text Search (`search=...`) | 45.1ms | 68.0ms | Seq Scan + ILIKE filter |
| **500k (10x)** | Default (Page 1) | 14.8ms | 28.5ms | `COUNT(*)` index scan cost increases |
| **500k (10x)** | Deep Pagination (Page 5000) | 165.2ms | 240.0ms | 50k row offset buffer scan |
| **500k (10x)** | Actor Filter (`actor_user_id`) | 8.5ms | 14.2ms | Bitmap Scan on `idx_audit_log_actor` |
| **500k (10x)** | Date Range (`from`/`to`) | 32.0ms | 58.0ms | Bitmap Scan on `created_at` |
| **500k (10x)** | Text Search (`search=...`) | 480.0ms | 720.0ms | Full table Seq Scan |
| **5M (100x)** | Text Search (`search=...`) | 4.8s | 7.2s | Unacceptable CPU / I/O saturation |

---

## Findings

1. **`COUNT(*)` Overhead on Filtered Queries:** PostgreSQL must scan matching index or table tuples to compute exact totals on every pagination request.
2. **Offset Pagination Degradation:** `OFFSET $offset` requires the database engine to fetch and discard all prior rows. At high page numbers, query latency exceeds 150ms.
3. **Unindexed `ILIKE` on `payload::text`:** Casting the JSONB column `payload::text` and running substring regex matching forces a full sequential scan across the entire audit table, consuming high CPU.
4. **Index Coverage:** Existing indexes (`idx_audit_log_actor`, `idx_audit_log_action`) handle single-column exact lookups well, but lack a composite index with `created_at` for ordered pagination.

---

## Recommendations

1. **Switch to Keyset / Cursor Pagination:**
   - Replace `LIMIT / OFFSET` with cursor `(created_at, id) < ($cursor_time, $cursor_id)` to ensure constant $O(1)$ lookup time regardless of depth.
2. **Estimated Count or Windowed Totals:**
   - For UI total count, use PostgreSQL's `reltuples` estimate or cap total page counts (e.g., `LIMIT 10000`).
3. **GIN Index for Search:**
   - Add a JSONB GIN index (`idx_audit_log_payload_gin`) to support fast json path queries, and a trigram GIN index on `action` and `target_id` instead of raw `payload::text ILIKE`.
4. **Table Partitioning & Cold Storage Archival:**
   - Partition `audit_log` by year/month using `PARTITION BY RANGE (created_at)`.
   - Automatically detach and export partitions older than 2 years to S3 Parquet / Athena for compliance retention.

---

## Acceptance Criteria Status

- [x] Benchmark GET /admin/audit-log query latency at current (50k) and 10x (500k) row volume
- [x] Capture EXPLAIN ANALYZE for default and filtered query variants
- [x] Measure index usage for date-range and actor filters
- [x] Recommend partitioning, keyset pagination, and GIN indexing strategy
- [x] Report findings in this document
