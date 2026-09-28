# RFC 0967: Enforce `NOTIFICATION_KINDS` as the single source of notification kinds

- Status: Proposed
- Issue: #967

## Summary

Make `NOTIFICATION_KINDS` the only source of kind strings by typing the single
insert path, `createNotification(userId, kind, message)` in `apps/api/src/db.ts`,
to accept `NotificationKind` instead of `string`, and add a lint rule as a
backstop.

## 1. Audit of emission sites

All notification inserts go through one function:
`db.ts` `createNotification(userId: string, kind: string, message: string)`
(the only `INSERT INTO notifications` in `apps/api/src`). The `kind`
parameter is typed `string`, so the constants file gives no compile-time
protection.

Callers using the constant (import `NOTIFICATION_KINDS`): `services/onboarding-drip.ts`,
`services/deposit-schedules.ts`, `services/scheduled-withdrawals.ts`,
`services/credit-lines.ts`, `services/upgrade-notifications.ts`,
`jobs/scheduled-compliance-reports.ts`, `routes/support-tickets.ts`,
`routes/admin.ts`, `routes/importers.ts`.

**Callers using raw strings (the bug class this RFC targets):**

| Call site | Raw kind | In registry? |
| --- | --- | --- |
| `jobs/sla-breach-checker.ts:61` | `'sla_breach'` | Yes (`SLA_BREACH`), value matches, but not enforced |
| `jobs/compliance-escalation.ts:107` | `'compliance_escalation'` | **No**, an unregistered kind |

`services/upgrade-notifications.ts` passes a `kind` variable, but it comes from
a `kindMap` of `NOTIFICATION_KINDS.*` values, so it is registry-backed.

Consumer: `routes/notifications.ts` reads `kind` straight from the row and
returns it (`kind: n.kind`); it does not validate against the registry, so an
unregistered kind such as `compliance_escalation` is stored and returned, but
any client-side filtering/display keyed on registry values silently
misses it. `services/notification-preferences.ts` also imports the registry;
preferences keyed by kind will not cover unregistered kinds.

## 2. Proposal: typed `emitNotification` as the only path

Keep the name `createNotification` (avoid churn) or rename to
`emitNotification`; the signature is what matters:

```ts
import type { NotificationKind } from './constants/notification-kinds.js';

export async function emitNotification(
  userId: string,
  kind: NotificationKind,
  message: string
): Promise<void>
```

- A raw literal that is not in the registry then fails `tsc`. A literal that
  *is* in the registry, such as `'sla_breach'`, still type-checks, because the
  union is the string values, so the lint rule in §3 is needed to require the
  constant.
- Add a runtime guard (`isNotificationKind(kind)`) that logs and throws in
  test/dev and logs an error in production, so a bad kind from an `as`-cast
  cannot silently persist.
- Register `compliance_escalation` as `COMPLIANCE_ESCALATION` (the
  registry needs it regardless).

## 3. Lint / TypeScript enforcement

1. **Types:** the signature above (catches unregistered kinds).
2. **ESLint** (`packages/eslint-config`), scoped to `apps/api/src/{jobs,routes,services}/**`:
   `no-restricted-syntax` on
   `CallExpression[callee.name=/^(createNotification|emitNotification)$/] > Literal:nth-child(2)`,
   with the message "Use NOTIFICATION_KINDS.*, not a string literal".
3. **DB (optional, later):** a `CHECK (kind IN (...))` constraint is *not*
   proposed now: the column is intentionally plain `TEXT` (see the comment in
   `constants/notification-kinds.ts`) and old rows may contain retired kinds. A test
   that asserts every `NOTIFICATION_KINDS` value is handled by
   `notification-preferences` is a cheaper guard.

## 4. Migration plan

1. Add `COMPLIANCE_ESCALATION` to the registry.
2. Change `jobs/sla-breach-checker.ts` and `jobs/compliance-escalation.ts` to
   `NOTIFICATION_KINDS.*`.
3. Tighten the `createNotification` signature to `NotificationKind`; fix any
   remaining compile errors.
4. Add the ESLint rule and a unit test that a bad kind is rejected.
5. Optionally rename to `emitNotification` with a deprecated re-export.

## 5. Trade-offs

**Enforce:** removes a class of silently mis-filtered notifications; the two
existing raw-string sites are proof it already happens; near-zero runtime cost.

**Costs:** one more import per emission site (already true for most); a lint
rule to maintain; a stricter type means adding a kind is a two-step change
(registry, then caller), which is the point; the runtime guard adds a branch
on a cold path; rows written under old/unregistered kinds (e.g. historical
`compliance_escalation`) still exist, so the consumer must keep tolerating
unknown kinds when reading.
