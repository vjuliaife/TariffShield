# RFC 0959: Migration runner: tracked checksums and safer rollback

- Status: Proposed
- Issue: #959

## Summary

Extend the existing runner (`apps/api/src/migrations/runner.ts`) rather than
adopt a new tool: track applied migrations by **name plus content checksum**,
apply **every** unapplied migration instead of "everything above the highest
version", take a Postgres advisory lock, support multi-step rollback, and add a
static CI check (no database needed) that rejects duplicate version numbers and
edits to already-merged migrations. This fixes two problems that exist on `main`
today (below), which the issue's premise did not anticipate.

## 1. Current runner behavior (as of `main`)

Corrections to the issue text: there are **22** migration files, not 4
(`0001` to `0019`), and **rollback and `down` migrations already exist**.

- **Ordering:** files matching `^\d{4}_[\w-]+\.(ts|js)$` are sorted by the
  integer prefix.
- **Tracking:** `schema_migrations(version INTEGER PRIMARY KEY, name TEXT,
  applied_at TIMESTAMPTZ)`. No checksum column.
- **What is pending:** `version > SELECT MAX(version) FROM schema_migrations`.
- **Duplicate versions:** the runner throws
  `Duplicate migration version detected: N` if two files share a prefix.
- **Transactions:** each migration runs in `BEGIN`/`COMMIT` on one client and
  rolls back on error. A migration exporting `nonTransactional = true` (for
  `CREATE INDEX CONCURRENTLY`) runs on its own connection with no transaction,
  and so is not all-or-nothing.
- **Rollback:** `runMigrations('rollback')` reverts **only the single highest
  applied version** by calling its `down()`, then deletes its row. All 22
  files export `down` (checked by search). It is exposed as
  `npm run migrate:rollback`. There is no "roll back N" or "to version V".
- **Concurrency:** no advisory lock. `index.ts` runs `migrate()` on boot when
  `!isProduction`, so several dev/staging replicas starting together can race
  (production migrates via a separate `npm run migrate` step).
- **Second schema source:** `db.ts`'s `rollback()` also runs a large
  "baseline schema ensure" block of `CREATE TABLE IF NOT EXISTS ...`
  statements (per the comment in `0004_supplementary_schema.ts`). Schema that
  exists in two places can drift from the migration chain without either
  being wrong on its own.

### What is *not* detected today

1. **An edited historical migration.** Nothing records what was applied.
   Changing `0003_...ts` after it ran in production makes new environments
   diverge from production with no signal.
2. **A migration added with a lower number than the current max.** Because
   pending is defined as `version > MAX(version)`, a file numbered below the
   highest applied version is **silently never applied**.
3. **Partially-applied `nonTransactional` migrations** (a failed `CONCURRENTLY`
   index leaves an `INVALID` index behind; the row is not inserted, so the next
   run retries on top of the debris).

### Problems visible on `main` right now

Three version numbers are each used by **two** files:

| Version | Files |
| --- | --- |
| 0011 | `0011_bulk_kyc_credit_lines_approval_chains.ts`, `0011_scheduled_compliance_report_delivery.ts` |
| 0012 | `0012_dispute_evidence.ts`, `0012_tenant_branding.ts` |
| 0013 | `0013_deposit_schedules.ts`, `0013_tickets_notification_prefs_broker_role.ts` |

I reproduced the runner's duplicate check on the current file listing and it
fails at version 11, so `npm run db:migrate` cannot succeed against an empty
database on `main`. Caveat on evidence: the `api-integration` workflow (which
runs `db:migrate`) is currently red on `main`, but it fails earlier, at
`npm ci`, so CI is **not** what exposes this: **no CI job currently reaches
the migration step**, and the duplicate-version guard runs only at runtime.

It is also exactly the scenario in (2): two PRs each took "the next number",
and merged in sequence. If either pair was applied in an environment before
its twin merged, `MAX(version)` skipped the twin permanently. Which files
actually ran where is knowable from `schema_migrations.name` in each
environment, and must be checked before renumbering (section 3).

## 2. Options

### Option A: extend `runner.ts` (recommended)

Changes:

1. **Identity = filename, not integer.**
   `schema_migrations` gains `checksum TEXT` and a `UNIQUE(name)`; `version`
   stops being the primary key. Pending = all files whose `name` is not in the
   table, ordered by `(version, name)`. This removes hazard (2) and makes the
   duplicate-number state representable instead of fatal.
2. **Checksums.** On each run, before applying anything, compute
   `sha256(file contents)` for every applied migration file and compare to the
   stored value. Any mismatch aborts with the file name and both hashes;
   an explicit `--accept-checksum <name>` escape hatch (logged, audited)
   covers a deliberate comment-only fix.
3. **Missing file for an applied row** aborts (today only rollback notices).
4. **Advisory lock** (`pg_advisory_lock(<constant>)`) around the whole run, so
   concurrent boots serialize.
5. **Multi-step rollback:** `--steps N` / `--to <name>`, each step in its own
   transaction, refusing to proceed past a migration with no `down` or a
   checksum mismatch. Default stays 1, so `migrate:rollback` is unchanged.
6. **Non-transactional migrations** record a *started* row state (or a
   `status` column: `applying` / `applied`) so an interrupted `CONCURRENTLY`
   migration is reported as "needs manual cleanup" instead of blindly retried.
7. **Static checks script** (`scripts/check-migrations.mjs`, section 4).

Size: the runner is ~170 lines; this is one new column, a hash loop and a lock,
plus tests.

### Option B: adopt an existing tool

| Tool | Checksums of applied files | `down` / rollback | Fit with this repo |
| --- | --- | --- | --- |
| `node-pg-migrate` | No content checksum; verifies *order* of applied vs. files (`checkOrder`), which would catch hazard (2) | Yes (`up`/`down`) | Closest to today's model (JS/TS, `pg`). Would need the 22 files' `up(client)` rewritten to its `pgm` API or wrapped with `pgm.db`/`noTransaction` for `nonTransactional`. |
| Prisma Migrate | Yes (stored per migration, detects edits) | **No down migrations** (roll-forward; `migrate resolve` to mark state) | Requires adopting the Prisma schema and its migration format. The API uses raw `pg`, and this would be a large, invasive change. |
| Flyway / Atlas / Sqitch | Flyway validates checksums; Atlas has a lock file | Undo is limited or paid depending on tool | Adds a non-Node runtime and re-expresses 22 TS migrations as SQL. |

Tool capabilities are as I understand them from the tools' documentation; they
should be re-verified against the versions being evaluated before deciding.

### Comparison

| | A: extend runner | B: node-pg-migrate |
| --- | --- | --- |
| Checksums | Add (small) | Not built in; still need custom code |
| Rollback | Extend existing `down` support | Built in |
| Ordering hazard (2) | Fixed by name identity | Fixed by `checkOrder` |
| Converting the 22 files | None | Rewrite or wrap all 22, including `nonTransactional` ones |
| New dependency / lock-in | None | One dependency |
| Operational risk of transition | Low: additive column, same files | Medium: history table changes, every env must be re-baselined at once |
| Maintenance burden | We own ~250 lines | Upstream owns it |

**Recommendation: A.** The remaining gaps (checksums, order/identity, lock) are
small additions to a runner that already handles transactions, rollback and
`CONCURRENTLY` migrations the way this codebase needs. Option B swaps a working
runner for a transition whose risk lands on the same migrations that are
already inconsistent.

## 3. Migration path for the existing 22 files

1. **Audit first (read-only).** In every environment run
   `SELECT version, name FROM schema_migrations ORDER BY version;` and diff
   against the file listing. Record, for each duplicated version (0011, 0012,
   0013), which file's `name` was applied and where. Also list any file whose
   version is at or below the max but whose `name` is missing.
2. **Resolve the duplicates**, using step 1's result, in one PR:
   - The twin that was **applied** keeps its number and name (renaming it would
     desynchronize `schema_migrations.name`; if a rename is unavoidable the PR
     includes an `UPDATE schema_migrations SET name = ...`).
   - The twin that was **not applied** anywhere is renumbered to the next free
     numbers (`0020`+), so it is applied by the new runner's name-based
     logic even though its old number is below `MAX`.
   - If **both** were applied somewhere, nothing is renumbered; the new runner
     already accepts two files sharing a version (identity is the name) and only
     the static check needs an explicit allowlist entry for these three
     grandfathered pairs.
3. **Ship the schema change** (`checksum` column, `UNIQUE(name)`, drop
   `version` as PK) as the runner's own bootstrap step, additive and idempotent
   (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
4. **Backfill checksums** for rows with `checksum IS NULL`. This is
   trust-on-first-use: it trusts whatever the file says *now*. To avoid
   baselining an already-edited file, generate `migrations/checksums.json` from
   the **git history** (hash of each file at the commit that introduced it,
   `git log --diff-filter=A`), commit it, and have the backfill compare against
   that manifest instead of the working tree. Any file that differs from its
   introduction commit is listed for human review before it is baselined.
5. **Turn on enforcement** (mismatch aborts) after all environments have
   backfilled once.

Nothing in steps 3 to 4 changes what any migration *does*; rollback of the new
runner itself is dropping the `checksum` column.

## 4. How CI catches an edited historical migration

Two independent guards, neither needing a database, wired into `lint.yml` (or a
new workflow) so they run even while the integration job is red:

1. **Diff guard on pull requests.** Compare against the base branch:
   `git diff --name-status origin/$BASE...HEAD -- apps/api/src/migrations/`.
   Fail on any `M`, `D` or `R` of a file that exists on base (only `A` is allowed),
   unless the PR carries a `migration-edit-approved` label (same pattern as
   the repo's existing `large-pr-approved` label in `pr-size.yml`).
2. **Static consistency check** (`scripts/check-migrations.mjs`):
   - no two files share a `name`; no two share a `version` unless allowlisted;
   - **every file exports both `up` and `down`** (parse or import);
   - `checksums.json` matches every existing file and lists every file
     (a new migration adds its own entry in the same PR).
   - the version of a **new** file is greater than the highest version on base.
     This is what stops two concurrent PRs from both taking the same "next
     number": the second to merge must renumber, and the check fails
     mechanically at PR time, which today it does not.

A third check belongs in the existing Postgres-backed job once `npm ci` is
fixed: **`up` all, `down` all (N steps), `up` all** on an empty database, which
proves every `down` actually works. Today nothing exercises `down`.

## 5. Trade-offs

**Extend the runner (A)**

- (+) Smallest change; no history rewrite; keeps `nonTransactional` semantics
  the team already relied on.
- (+) Fixes the silent-skip hazard and detects edited history.
- (-) The team owns migration tooling, including lock and checksum edge cases,
  indefinitely.
- (-) Checksum backfill trusts current file contents unless the git-history
  manifest is used (step 4), which is extra one-time work.
- (-) Checksums make *harmless* edits (comments, formatting) fail; the
  accept-checksum escape hatch is needed and must itself be audited.

**Adopt a tool (B)**

- (+) Less bespoke code to maintain, and a community behind edge cases.
- (-) Transition risk concentrates on a chain that already has inconsistent
  history; every environment must be re-baselined at once.
- (-) It still would not provide content checksums (node-pg-migrate) or `down`
  (Prisma), so part of Option A's work remains either way.

**Stay forward-only with no checks**

- (+) No work.
- (-) Leaves the duplicate-number state and the silent-skip hazard in place;
  both already occurred.

**Operational risk during the transition (either option):** the riskiest
moment is enabling enforcement in an environment whose `schema_migrations` does
not match the files, which is why section 3 starts with a read-only audit and
enforcement is a separate, later step.
