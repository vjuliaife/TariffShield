# RFC 0966: Compliance module boundary in `apps/api`

- Status: Proposed
- Issue: #966

## Summary

Group compliance-domain routers behind a dedicated `routes/compliance/`
module and a single `complianceModule` router that applies a shared middleware
stack (auth, ToS/privacy gates, audit logging, stricter rate limit). Public URL
paths do not change.

## 1. Classification of `routes/*.ts`

Source: `apps/api/src/routes` and the mounts in `apps/api/src/index.ts`.

**Compliance-domain**

| File | Mount |
| --- | --- |
| `compliance.ts` | `/compliance` |
| `compliance-report-links.ts` | `/compliance-report-links` (unauthenticated, token-gated) |
| `regulatory.ts` | `/api/v1/regulatory` |
| `privacy.ts` | `/account`, `/privacy` |
| `tos.ts` | `/account` |
| `erasure.ts` | **not mounted** (see below) |
| `surety-license.ts` | `/surety-license` |
| `kyc.ts` | `/importers` (borderline; see below) |

**Core-domain:** `importers.ts`, `broker.ts`, `bond-annotations.ts`,
`bond-signatures.ts`, `surety-marketplace.ts`, `upgrade-subscriptions.ts`,
`hts-lookup.ts`, `sla.ts`.

**Platform/other:** `auth.ts`, `admin.ts`, `api-keys.ts`, `developer.ts`,
`health.ts`, `notifications.ts`, `nps.ts`, `onboarding.ts`, `branding.ts`,
`report-templates.ts`, `support-tickets.ts`.

`kyc.ts` is mounted under `/importers` and is part of onboarding, but handles
KYC documents (PII). Proposal: classify as compliance, keep its mount path.

### Finding: `erasureRouter` is never mounted

`routes/erasure.ts` exports `erasureRouter` (GDPR erasure requests and
retention policies) but nothing in `apps/api/src` imports it, so those
endpoints are currently unreachable. This is exactly the failure mode of the
current flat layout: mounting is per-file and easy to miss. It should be
confirmed as a bug and fixed as part of, or before, this migration.

## 2. What compliance routes need differently

Today each file opts in ad hoc: `erasure.ts` applies `authMiddleware`,
`privacyReacceptanceGate`, `tosReacceptanceGate` itself; `privacy.ts` applies
only `authMiddleware`; `logAudit` is called from just `regulatory.ts` (1) and
`erasure.ts` (2) among the compliance files.

Requirements that differ from core routes:

1. **Mandatory audit logging** of every state-changing request (actor, route,
   target subject, outcome), not left to handlers. GDPR/SOC 2 evidence.
2. **Consistent gates:** auth plus ToS/privacy re-acceptance, except the ToS
   and privacy acceptance endpoints themselves, which must remain reachable.
3. **Stricter rate limits** on erasure, export and report-link endpoints;
   today only `/auth/login` and `/auth/signup` have a limiter.
4. **No PII in logs/error bodies**, and a uniform error shape.
5. **Explicit public exceptions**, i.e. `compliance-report-links` is
   token-gated and unauthenticated by design and must be listed, not implied.

## 3. Proposed module boundary

```
apps/api/src/routes/compliance/
  index.ts            // complianceModule: Router with shared stack
  compliance.ts  regulatory.ts  privacy.ts  tos.ts
  erasure.ts  surety-license.ts  report-links.ts (public sub-router)
  middleware.ts       // complianceAudit, complianceRateLimit
```

`complianceModule` applies, in order: `complianceRateLimit` →
`authMiddleware` → `complianceAudit` (logs via `logAudit` on response finish
for non-GET) and mounts each sub-router. Gates are added per sub-router where
they must be skipped (`tos`, `privacy` acceptance). The public report-links
router mounts *before* the authenticated stack.

`index.ts` then mounts the module once instead of ~8 individual lines, so a
new compliance router cannot be added without inheriting the stack.

## 4. Migration plan (paths preserved)

Backward compatibility is guaranteed by mounting the module at the same
prefixes with an internal path table instead of moving URLs:

1. Fix/mount `erasureRouter` first (own PR, with a test that `/account/erasure-request` responds).
2. Add `routes/compliance/middleware.ts` with audit + rate-limit; no behavior
   change for existing routes yet.
3. `git mv` route files into `routes/compliance/` (history preserved) one
   file per PR to keep conflicts small; update imports only.
4. Introduce `complianceModule`, mount at the existing prefixes
   (`/compliance`, `/account`, `/privacy`, `/surety-license`,
   `/api/v1/regulatory`), and delete the per-file mounts from `index.ts`.
5. Remove per-file duplicate gates once the module applies them.
6. Snapshot test the route table (method + path) before and after to prove no
   path changed.

## 5. Trade-offs

**Reorganize:** independently auditable scope for SOC 2/GDPR; new compliance
routes get audit/rate-limit by construction; would have caught the unmounted
erasure router; simpler `index.ts`.

**Stay flat:** no churn. But the security posture depends on every author
remembering to opt in, which is already inconsistent.

**Costs/risks:** merge conflicts on files other contributors are editing
(mitigated by move-only PRs); URL-prefix mixing (`/account` is shared with
non-compliance `api-keys`) means the module boundary is directory-level, not
purely URL-level; an over-eager blanket audit middleware can log too much, so
it should record metadata only, never bodies.
