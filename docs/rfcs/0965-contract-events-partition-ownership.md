# RFC 0965: Ownership of the `contract_events` partition lifecycle

- Status: Proposed
- Issue: #965

## Summary

`lib/contract-events-partitions.ts` owns all partition-lifecycle policy
(creation ahead of need, retention/drop). `jobs/ensure-contract-events-partitions.ts`
becomes a thin scheduler that calls one lib entry point.

## 1. Current split

**`apps/api/src/lib/contract-events-partitions.ts`** (pure, no `pg` import):
`monthRange`, `monthsBetweenInclusive`, `createContractEventsPartition`
(creates the partition and its per-partition unique index on
`(ledger_sequence, event_index)`).

**`apps/api/src/jobs/ensure-contract-events-partitions.ts`**: holds the
*policy*: `MONTHS_AHEAD = 2`, `CHECK_INTERVAL_MS = 24h`, the "now + offset"
month computation, the Prometheus counter, and the `setInterval` + boot-time
prime.

**`migrations/0002_partition_contract_events.ts`**: one-time cutover; uses
`monthsBetweenInclusive` with its own lookahead constant, and creates the
`contract_events_default` partition.

So the lookahead policy is defined twice (migration and job), and the
"which months should exist" logic lives in the job, not the lib.

## 2. Are old partitions ever dropped?

**No.** A search for `DROP`/`DETACH` on `contract_events` partitions finds
nothing in `apps/api/src`. Partitions are only created. Additionally,
`jobs/retention-enforcement.ts` explicitly *retains* `contract_events`
("retains financial aggregate rows ... but nulls PII") and has no
`contract_events` statements. The table grows unbounded; the only benefit
of partitioning today is pruning for time-bounded queries.

## 3. Proposal

Move policy into the lib:

```ts
// lib/contract-events-partitions.ts
export const PARTITION_POLICY = { monthsAhead: 2, retentionMonths: null /* see §4 */ };
export function plannedMonths(now: Date, policy = PARTITION_POLICY): MonthRange[];
export async function ensureUpcomingPartitions(db: Queryable, now = new Date()): Promise<void>;
export async function enforcePartitionRetention(db: Queryable, now = new Date()): Promise<{ detached: string[] }>;
```

The job keeps only: timer, boot prime, metrics/logging, and a call to
`ensureUpcomingPartitions` (and later `enforcePartitionRetention`). The
migration imports the same `PARTITION_POLICY.monthsAhead`. Because the lib
stays dependency-free and takes a `Queryable`, it remains unit-testable
without a database.

## 4. Retention policy

Current: **none** (keep forever). Proposed, to be confirmed by
compliance before implementation:

- Keep `N` months hot (proposal: 24) as attached partitions.
- Older partitions are `DETACH PARTITION ... CONCURRENTLY`-ed, not dropped.
  They are exported to cold storage and only then dropped, because
  `contract_events` is a financial audit trail and the on-chain source can be
  re-indexed but not cheaply.
- Never touch `contract_events_default`, and never detach a partition that
  contains rows under a `retention_holds` entry.
- Detach/drop actions are written to `retention_audit_log`, the same table
  `jobs/retention-enforcement.ts` uses, so there is one audit trail. The
  scheduling may live in `retention-enforcement.ts` calling
  `enforcePartitionRetention`, or in the partition job; either is fine as long
  as the *logic* is in the lib.

Until the policy is agreed, `retentionMonths: null` makes
`enforcePartitionRetention` a no-op, so the refactor is behavior-neutral.

## 5. Trade-offs

**Consolidate:** one place to reason about partition bugs; policy constants
defined once; testable planning logic; a natural home for retention.

**Keep the split:** it works today, and the diff touches a file that runs at
boot. Risk is low because `CREATE ... IF NOT EXISTS` is idempotent and the
default partition absorbs any miss.

**Retention risk:** detaching partitions is destructive-adjacent and needs a
legal sign-off, so it ships behind `retentionMonths: null`.

## 6. Migration steps

1. Add `PARTITION_POLICY`, `plannedMonths`, `ensureUpcomingPartitions` to the
   lib, with unit tests for month rollover (Dec→Jan) and lookahead.
2. Reduce the job to call `ensureUpcomingPartitions`; keep the metric names.
3. Point the migration at `PARTITION_POLICY`.
4. Add `enforcePartitionRetention` (no-op by default) and document the agreed
   policy in `docs/OPERATIONS_RUNBOOK.md`.
