# RFC 0958: Version the `tx-submit` job payload so in-flight jobs survive worker deploys

- Status: Proposed
- Issue: #958

## Summary

Add a `schemaVersion` to `TxSubmitJobData`, have the worker dispatch on it
through a per-version handler table, and define what happens to jobs whose
version the worker does not know. Pair it with a deploy-ordering rule
(consumer before producer) recorded in the runbook.

## 1. Current state

`apps/api/src/queue.ts`:

```ts
export interface TxSubmitJobData {
  method: 'deposit' | 'auto_top_up' | 'withdraw' | 'accrue_yield'
        | 'clawback' | 'set_required_collateral' | 'register';
  importerId: string;
  keypairSecret?: string;          // !
  platformKey?: boolean;
  suretyKey?: boolean;
  args: Record<string, unknown>;   // untyped, per-method shape
}
```

- **Producers:** `enqueueTxSubmit()` has 8 call sites: `routes/importers.ts` (6),
  `services/deposit-schedules.ts` (1) and `services/scheduled-withdrawals.ts` (1). Producers run in the API process.
- **Consumer:** `createTxSubmitWorker()` in the same file, started by
  `worker.ts`, a separate process. Its handler destructures `job.data` and
  `switch`es on `method`, casting `args.*` per case
  (`BigInt(args.amountStroops as string)`, ...). There is no validation of
  `args` and no version awareness.
- **Persistence:** jobs live in Redis under queue `tx-submit`, with
  `attempts: 2`, exponential backoff of 2s, `removeOnComplete: true` and
  **`removeOnFail: false`**. Failed jobs are retained indefinitely and can be
  retried long after the deploy that produced them.
- The queue and the on-chain account cache share the Redis instance
  (`REDIS_URL`).

### Failure modes during a rolling deploy

| Change | New API + old worker | Old API + new worker |
| --- | --- | --- |
| Add optional field to `args` | Old worker ignores it. Silent loss of the new behavior. | Fine if the new worker treats it as optional. |
| Add **required** arg / new `method` | `default` of the `switch` is absent, so an unknown method leaves `onChain` **unassigned** and the next line throws `TypeError` on `onChain.txHash` (TypeScript flags this only if the switch is not exhaustive). The job fails, retries once, and is kept as failed. | New worker sees an old job missing the required arg: `BigInt(undefined)` throws. |
| Rename / retype an arg | Wrong value passed to the contract, or a throw. | Same. |

Two properties make this worse than an ordinary retry problem:

1. The failure happens **after** the API already returned `202` and a `jobId`
   to the client. Nothing tells the caller that the job will never succeed
   apart from its polling endpoint eventually reporting failure.
2. The mismatch is indistinguishable from a real failure (transaction error,
   RPC outage): both surface as a generic thrown `Error` and consume the same
   two attempts.

There is no test coverage for a job enqueued by a different code version.

### Adjacent finding (relevant to the payload shape)

`keypairSecret` (the importer's secret key, `stellar_secret_encrypted` as
passed by the routes) is stored **inside the job payload in Redis**, and jobs
are kept on failure. That is a stronger reason to touch the payload shape
than versioning alone; see the v2 note in section 2. It is called out, not
fixed, here.

## 2. Proposal

### Payload

```ts
export const TX_SUBMIT_SCHEMA_VERSION = 1;

export interface TxSubmitJobData {
  schemaVersion: number;   // required for all new jobs
  ...existing fields
}
```

- `enqueueTxSubmit()` stamps `schemaVersion: TX_SUBMIT_SCHEMA_VERSION`; callers
  do not set it (one place to change, none of the 8 call sites change).
- A missing `schemaVersion` on a job is interpreted as **version 0**: the
  shape that exists today. This makes the change itself deployable without a
  drain (old jobs in Redis are still handled).

### Dispatch in the worker

```ts
const handlers: Record<number, (job: Job<TxSubmitJobData>) => Promise<TxSubmitJobResult>> = {
  0: handleV1Shape,   // today's body, moved unchanged
  1: handleV1Shape,   // identical until the shape actually changes
};

async (job) => {
  const v = job.data.schemaVersion ?? 0;
  const handler = handlers[v];
  if (!handler) throw new UnrecognizedJobVersionError(v, job.id);
  return handler(job);
}
```

When the shape next changes, the developer adds `handlers[2]` and either
keeps `handlers[1]` (worker supports both) or converts v1 to v2 in a small pure
`upgradeV1toV2(data)` function called at the top of `handlers[1]`. A pure
upgrader is unit-testable with fixture payloads, which closes the missing
test coverage: keep one JSON fixture per released version and assert
each still handles.

### Unrecognized or too-old version

Two distinct cases, deliberately handled differently:

| Case | Meaning | Behavior |
| --- | --- | --- |
| `v` **newer** than the worker knows | Old worker, new producer (deploy ordering violated). Job is probably valid. | **Retry later, do not consume attempts.** Move to delayed with `job.moveToDelayed(now + 30s)` and throw `DelayedError`; after a cap (e.g. 10 min) fail as dead-letter. When the worker rollout completes, it is picked up normally. |
| `v` **older** than the oldest supported handler | A retained failed job or a stale delayed job from a long-retired shape. | **Dead-letter, no retry:** `UnrecoverableError`, plus a structured error log and a counter metric (`tx_submit_unrecognized_version_total{version}`). Never best-effort transform: these jobs move funds, and a guessed argument mapping is worse than a failure. |

"Best-effort transform" is rejected for money-moving jobs; only explicit,
tested upgraders (`upgradeVNtoVN+1`) are allowed.

The worker should also `zod`-validate `args` per `method` inside each handler,
so a malformed job becomes an `UnrecoverableError` (no retry) rather than a
`TypeError` from `BigInt(undefined)`. Also add a `default:` branch to the
`switch` that throws on unknown `method`, closing the unassigned-`onChain`
hole above.

### Deploy sequencing (for the runbook)

1. **Consumer first.** Deploy the worker with the new handler *before* any API
   instance that produces the new version. The worker must accept both N and
   N+1 during the window.
2. Deploy the API. New jobs are stamped N+1.
3. **Contract phase**, at least one release later and once the queue holds no
   v N jobs (check `txSubmitQueue.getJobCounts()` and failed-set contents):
   remove `handlers[N]` and its upgrader.
4. A **rollback** of the API leaves N+1 jobs in the queue, so the previous
   worker must not be rolled back before those are drained. Rule: never roll
   the worker back past a version that has produced jobs still in Redis.
5. The API and worker ship from one repo and image
   (`apps/api`), so the mismatch window is only the rolling-update overlap
   and any retained failed jobs.

## 3. Trade-offs

**Add versioning**

- (+) Removes a class of rolling-deploy failures and makes "unknown shape" a
  defined, observable, non-retried-in-vain outcome instead of an accidental
  `TypeError`.
- (+) Gives a place for tested upgraders and fixtures; the failed-job
  retention (`removeOnFail: false`) becomes safe to rely on.
- (-) A small permanent tax: one integer, a handler table, and a discipline to
  bump it (a lint/test that fails when `TxSubmitJobData` changes without a
  version bump would enforce this cheaply, for example by snapshotting the
  zod schema of each version).
- (-) Supporting N and N+1 in the worker is extra code for one release.

**Rely on coordinated deploys (status quo)**

- (+) No code. Works while jobs are short-lived: `removeOnComplete: true`, a
  2s to 4s retry window, and one shared image.
- (-) Not true of `removeOnFail: false` jobs, of scheduled work
  (`deposit-schedules`, `scheduled-withdrawals` enqueue from timers), or of
  any deploy that stalls midway. The requirement is a human ordering rule that
  nothing enforces or tests.

**Recommendation:** add `schemaVersion` with version-0 back-compat now (a
no-op change in behavior), the handler table, the two unrecognized-version
behaviors above and the runbook ordering rule. Separately, replace
`keypairSecret` in the payload with an importer reference resolved by the
worker (that will be the first real version bump, and a good forcing
function for the process above).

## 4. Rollout

1. Stamp `schemaVersion`, treat missing as 0, move the handler body unchanged
   behind the table, add `default:` for unknown `method`. No behavior change.
2. Add version-mismatch handling and the metric; add fixture tests (v0 and v1
   payload per method) and a test that a v999 job is delayed then dead-lettered.
3. Add the deploy-ordering section to `docs/OPERATIONS_RUNBOOK.md`.
