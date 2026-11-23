# Hot-Path Query Analysis

> **Context**: Issue #257. Analysis performed on `apps/api/src/routes/importers.ts`
> by code inspection. The plan-type column reflects expected plan type after the
> indexes in `migrations/007_hot_path_indexes.sql` are applied. Actual EXPLAIN
> ANALYZE output should be captured at ≥ 1,000 importer rows and ≥ 50,000 event rows
> in a staging environment to validate execution time targets.

## Query table

| #   | Query name              | SQL summary                                                                                                 | Source code location                                                                  | Plan type (before) | Plan type (after) | Index added                               | Notes                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ | ----------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| 1   | `importer-exists-check` | `SELECT id FROM importers WHERE user_id = $1`                                                               | [`apps/api/src/routes/importers.ts#L94`](../apps/api/src/routes/importers.ts#L94)     | Seq Scan           | Index Scan        | `idx_importers_user_id`                   | Called on every POST / to prevent duplicate registration             |
| 2   | `importer-list-admin`   | `SELECT … FROM importers i JOIN users u … ORDER BY i.created_at DESC`                                       | [`apps/api/src/routes/importers.ts#L222`](../apps/api/src/routes/importers.ts#L222)   | Seq Scan + Sort    | Index Scan        | `idx_importers_created_at`                | Surety-admin list, no WHERE filter; sort drives need for index       |
| 3   | `importer-by-id-admin`  | `SELECT * FROM importers WHERE id = $1`                                                                     | [`apps/api/src/routes/importers.ts#L3127`](../apps/api/src/routes/importers.ts#L3127) | Index Scan         | Index Scan        | _(primary key)_                           | Already indexed; no change needed                                    |
| 4   | `importer-by-id-user`   | `SELECT * FROM importers WHERE id = $1 AND user_id = $2`                                                    | [`apps/api/src/routes/importers.ts#L3130`](../apps/api/src/routes/importers.ts#L3130) | Index Scan         | Index Scan        | `idx_importers_user_id`                   | PK lookup with additional user_id filter; user_id index narrows scan |
| 5   | `event-history-initial` | `SELECT … FROM contract_events WHERE importer_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`           | [`apps/api/src/routes/importers.ts#L1025`](../apps/api/src/routes/importers.ts#L1025) | Seq Scan           | Index Scan        | `idx_contract_events_importer_created_at` | Initial page load for GET /:id/events                                |
| 6   | `event-history-cursor`  | `SELECT … FROM contract_events WHERE importer_id = $1 AND (created_at, id) < ($2, $3) ORDER BY … LIMIT $4`  | [`apps/api/src/routes/importers.ts#L1019`](../apps/api/src/routes/importers.ts#L1019) | Seq Scan + Filter  | Index Scan        | `idx_contract_events_importer_created_at` | Subsequent pages; keyset cursor on `(created_at, id)`                |
| 7   | `bond-history`          | `SELECT … FROM bonds WHERE importer_id = $1 ORDER BY created_at DESC`                                       | [`apps/api/src/routes/importers.ts#L3252`](../apps/api/src/routes/importers.ts#L3252) | Seq Scan           | Index Scan        | `idx_bonds_importer_created_at`           | Called on every GET /:id/bonds                                       |
| 8   | `tariff-upload-latest`  | `SELECT * FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1`                      | [`apps/api/src/routes/importers.ts#L3154`](../apps/api/src/routes/importers.ts#L3154) | Seq Scan           | Index Scan        | `idx_tariff_uploads_importer_created_at`  | Latest tariff upload for verify-oracle-data                          |
| 9   | `tariff-upload-as-of`   | `SELECT * FROM tariff_uploads WHERE importer_id = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1` | [`apps/api/src/routes/importers.ts#L3150`](../apps/api/src/routes/importers.ts#L3150) | Seq Scan + Filter  | Index Scan        | `idx_tariff_uploads_importer_created_at`  | As-of-date variant; same index covers the range filter               |

## Reproducing this analysis locally

Contributors modifying query builders or indexes can reproduce the `EXPLAIN (ANALYZE, BUFFERS)` execution plans locally against PostgreSQL.

### 1. Data Volume & Synthetic Seeding

The default seed script (`npm run seed`) populates minimal development records (~10-20 importers). In small tables (< a few hundred rows), the PostgreSQL planner deliberately selects sequential scans (`Seq Scan`) because reading a handful of sequential disk blocks is cheaper than traversing B-tree index blocks.

The execution time targets and plan shapes in this document assume realistic production data volumes:

- **`importers`**: ≥ 1,000 rows
- **`contract_events`**: ≥ 50,000 rows
- **`bonds`**: ≥ 2,000 rows
- **`tariff_uploads`**: ≥ 5,000 rows

#### Generating synthetic benchmark data

Connect to your local Postgres container (`docker-compose up -d postgres`) via `psql`:

```bash
psql "postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield"
```

Execute the following script to insert synthetic benchmark records and update planner statistics:

```sql
BEGIN;

-- 1. Create 1,000 users and importers
INSERT INTO users (id, email, password_hash, role, created_at)
SELECT
  gen_random_uuid(),
  'bench_user_' || i || '@example.com',
  '$2b$10$epGkeC5e7u0B6vH50b4xReQe40u.M135e89hG7mQkG87m1oM453eS',
  'importer',
  NOW() - (i || ' minutes')::interval
FROM generate_series(1, 1000) AS i
ON CONFLICT (email) DO NOTHING;

INSERT INTO importers (id, user_id, legal_name, stellar_address, bond_id, kyc_status, created_at)
SELECT
  gen_random_uuid(),
  u.id,
  'Benchmark Importer LLC ' || row_number() OVER (),
  'G' || rpad(row_number() OVER ()::text, 55, 'A'),
  row_number() OVER (),
  'approved',
  NOW() - (row_number() OVER () || ' minutes')::interval
FROM users u
WHERE u.email LIKE 'bench_user_%'
ON CONFLICT DO NOTHING;

-- 2. Populate contract events (50,000 rows across importers)
WITH target_importers AS (
  SELECT id FROM importers ORDER BY created_at DESC LIMIT 50
)
INSERT INTO contract_events (id, importer_id, kind, amount, tx_hash, created_at)
SELECT
  i,
  (SELECT id FROM target_importers OFFSET (i % 50) LIMIT 1),
  CASE (i % 4)
    WHEN 0 THEN 'deposit'
    WHEN 1 THEN 'reserve'
    WHEN 2 THEN 'topup'
    ELSE 'withdraw'
  END,
  (100000000 + i)::numeric,
  md5(i::text),
  NOW() - (i || ' seconds')::interval
FROM generate_series(1, 50000) AS i
ON CONFLICT DO NOTHING;

-- 3. Populate bonds (2,000 rows)
INSERT INTO bonds (id, importer_id, bond_number, amount, status, created_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM importers OFFSET (i % 1000) LIMIT 1),
  'BOND-' || (100000 + i),
  500000,
  'active',
  NOW() - (i || ' hours')::interval
FROM generate_series(1, 2000) AS i
ON CONFLICT DO NOTHING;

-- 4. Populate tariff uploads (5,000 rows)
INSERT INTO tariff_uploads (id, importer_id, filename, annual_duty_total, computed_required_collateral, created_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM importers OFFSET (i % 1000) LIMIT 1),
  'upload_' || i || '.csv',
  250000 + i,
  25000 + (i / 10),
  NOW() - (i || ' hours')::interval
FROM generate_series(1, 5000) AS i
ON CONFLICT DO NOTHING;

-- Refresh table statistics for query planner
ANALYZE users;
ANALYZE importers;
ANALYZE contract_events;
ANALYZE bonds;
ANALYZE tariff_uploads;

COMMIT;
```

### 2. Exact EXPLAIN (ANALYZE, BUFFERS) Commands

Run the following parameterized queries in `psql` to measure planner cost and buffer cache hits:

```sql
-- Query 1: importer-exists-check
PREPARE q1 (uuid) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM importers WHERE user_id = $1;
EXECUTE q1((SELECT user_id FROM importers LIMIT 1));

-- Query 2: importer-list-admin
EXPLAIN (ANALYZE, BUFFERS)
SELECT i.*, u.email
FROM importers i
JOIN users u ON u.id = i.user_id
WHERE i.deleted_at IS NULL
ORDER BY i.created_at DESC
LIMIT 50;

-- Query 3: importer-by-id-admin
PREPARE q3 (uuid) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM importers WHERE id = $1;
EXECUTE q3((SELECT id FROM importers LIMIT 1));

-- Query 4: importer-by-id-user
PREPARE q4 (uuid, uuid) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM importers WHERE id = $1 AND user_id = $2;
EXECUTE q4((SELECT id FROM importers LIMIT 1), (SELECT user_id FROM importers LIMIT 1));

-- Query 5: event-history-initial
PREPARE q5 (uuid, int) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, kind, amount, tx_hash, created_at
FROM contract_events
WHERE importer_id = $1
ORDER BY id DESC
LIMIT $2;
EXECUTE q5((SELECT importer_id FROM contract_events LIMIT 1), 20);

-- Query 6: event-history-cursor
PREPARE q6 (uuid, bigint, int) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, kind, amount, tx_hash, created_at
FROM contract_events
WHERE importer_id = $1 AND id < $2
ORDER BY id DESC
LIMIT $3;
EXECUTE q6((SELECT importer_id FROM contract_events LIMIT 1), 25000, 20);

-- Query 7: bond-history
PREPARE q7 (uuid) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM bonds WHERE importer_id = $1 ORDER BY created_at DESC;
EXECUTE q7((SELECT importer_id FROM bonds LIMIT 1));

-- Query 8: tariff-upload-latest
PREPARE q8 (uuid) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1;
EXECUTE q8((SELECT importer_id FROM tariff_uploads LIMIT 1));

-- Query 9: tariff-upload-as-of
PREPARE q9 (uuid, timestamptz) AS
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM tariff_uploads WHERE importer_id = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1;
EXECUTE q9((SELECT importer_id FROM tariff_uploads LIMIT 1), NOW() - INTERVAL '1 day');
```

## Index summary

| Index name                                | Table             | Columns                                   | Type   | Migration |
| ----------------------------------------- | ----------------- | ----------------------------------------- | ------ | --------- |
| `idx_importers_user_id`                   | `importers`       | `user_id`                                 | B-tree | 007       |
| `idx_importers_created_at`                | `importers`       | `created_at DESC`                         | B-tree | 007       |
| `idx_contract_events_importer_created_at` | `contract_events` | `(importer_id, created_at DESC, id DESC)` | B-tree | 007       |
| `idx_bonds_importer_created_at`           | `bonds`           | `(importer_id, created_at DESC)`          | B-tree | 007       |
| `idx_tariff_uploads_importer_created_at`  | `tariff_uploads`  | `(importer_id, created_at DESC)`          | B-tree | 007       |

All indexes are created with `CONCURRENTLY` to avoid table-level locks in production.

## Existing indexes (not changed)

| Index name                          | Table               | Purpose                                            |
| ----------------------------------- | ------------------- | -------------------------------------------------- |
| `idx_oracle_price_feed_importer`    | `oracle_price_feed` | `(importer_id, created_at DESC)` — already optimal |
| `idx_oracle_price_feed_ledger`      | `oracle_price_feed` | `ledger_sequence` — listener checkpoint lookup     |
| `idx_oracle_price_feed_tx_importer` | `oracle_price_feed` | Unique on `(tx_hash, importer_address)` — dedup    |
| `idx_importers_deleted_at`          | `importers`         | Partial index for soft-delete filter               |
| `idx_contract_events_raw_gin`       | `contract_events`   | GIN on `raw` JSONB — event filtering by payload    |
| `idx_importers_legal_name_tsv`      | `importers`         | GIN on tsvector — full-text search                 |
| `idx_api_keys_user_id`              | `api_keys`          | User-scoped key lookups                            |
| `idx_api_keys_prefix`               | `api_keys`          | API key prefix lookup during auth                  |

## Validation steps

After applying migration 007, run the following on the staging DB to confirm all
new indexes are used:

```sql
-- Reset stats first
SELECT pg_stat_reset();

-- Run representative queries against realistic data, then:
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'idx_importers_user_id',
  'idx_importers_created_at',
  'idx_contract_events_importer_created_at',
  'idx_bonds_importer_created_at',
  'idx_tariff_uploads_importer_created_at'
)
ORDER BY indexrelname;
```

`idx_scan` should be > 0 for each index after representative queries are exercised.
Dead indexes (idx_scan = 0 after sufficient load) should be removed.

## Performance target

The goal is for the DB portion of `GET /importers/:id` to complete in < 10ms p95.
This endpoint calls `loadImporterFor` (queries #3 or #4 above), then reads the
on-chain account via Soroban RPC (not DB-bound). The DB portion alone should be
sub-millisecond for primary-key lookups with the new user_id index.

Event-history queries (#5 and #6) should stay below 5ms p95 with the compound
`(importer_id, created_at DESC, id DESC)` index at 50,000 event rows per importer.
