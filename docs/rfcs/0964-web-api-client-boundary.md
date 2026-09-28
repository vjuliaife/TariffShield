# RFC 0964: `apps/web` ↔ `apps/api` client boundary

- Status: Proposed
- Issue: #964

## Summary

`packages/sdk` owns all Soroban/contract interaction. A single module,
`apps/web/lib/api.ts`, owns every HTTP call from `apps/web` to `apps/api`.
Components and pages never call `fetch()` against the API directly.

## 1. Audit of current state

`fetch(` call sites under `apps/web/{app,components,lib,src}` (tests excluded):

| Site | Target | Notes |
| --- | --- | --- |
| `lib/api.ts` (`request()`) | `apps/api` via `NEXT_PUBLIC_API_URL` | The intended client. Injects `Authorization: Bearer`, throws `ApiError(status, message, details)`. ~680 lines, `api.*` namespace. |
| `components/OracleSignerRotation.tsx` (4 calls) | relative `/api/admin/oracle-signers/*` | Bypasses `request()`: no auth header, own error handling. Relative path targets the Next.js origin, not `apps/api`. |
| `components/HealthScore.tsx` | relative `/api/notifications/thresholds/:id` | Same problem; the result is not checked. |
| `components/TariffRateChart.tsx` | relative `/api/importers/:id/tariff-history` | Same problem; throws a generic `Error('Failed to load tariff history')`. |
| `lib/currency.ts` | third-party FX endpoint | Legitimately not `apps/api`; out of scope. |

Inconsistencies:

1. Three components call `/api/...` relative paths. `apps/web` has no
   `app/**/route.ts` handlers and `next.config.ts` defines no rewrites, so these
   paths appear to resolve to nothing unless a proxy is configured elsewhere; they bypass `NEXT_PUBLIC_API_URL`, the bearer token and `ApiError`.
2. Error handling is duplicated: `request()` throws `ApiError`, which
   `lib/error-formatter.ts` (`formatApiError`) understands. Ad hoc call sites
   do not, so users see raw messages.
3. `apps/web` does not import `@tariffshield/sdk` anywhere. The SDK is used by
   `apps/api`. Contract interaction from the browser is therefore not a
   present concern, but the boundary should be stated before it becomes one.

## 2. Proposed boundary

| Concern | Owner |
| --- | --- |
| Soroban contract calls, XDR building, contract types/compat | `packages/sdk` |
| Request/response types shared with the API | `packages/api-types` |
| All HTTP to `apps/api` from the web app | `apps/web/lib/api.ts` |
| Third-party HTTP (FX rates, etc.) | its own `lib/` module (e.g. `lib/currency.ts`), never in components |

`apps/web` may import `@tariffshield/sdk` for client-side signing/simulation
only. It must never use the SDK to reach `apps/api`, and the API client must
not build contract transactions.

## 3. Target client shape

Keep the existing `request<T>()` core and make it the single choke point:

```ts
// apps/web/lib/api.ts
async function request<T>(path: string, opts: {
  method?: string; body?: unknown; auth?: boolean; signal?: AbortSignal;
} = {}): Promise<T>
```

- **Auth header injection:** `Authorization: Bearer <token>` from `getToken()`
  (already implemented). `auth: false` for public endpoints.
- **Error normalization:** every non-2xx (and every network/JSON-parse failure)
  becomes `ApiError { status, message, details }`. Add `status: 0` for network
  failure and guard `JSON.parse` so a non-JSON error body does not throw a
  `SyntaxError`. UI code passes errors to `formatApiError`.
- **Base URL:** a single `BASE` from `NEXT_PUBLIC_API_URL`.
- **Cancellation:** optional `AbortSignal` so components can cancel on unmount.
- Endpoint groups stay as methods on the `api` object. Once `api.ts` grows
  further, split into `lib/api/{core,admin,importers,...}.ts` re-exported from
  `lib/api/index.ts`, still with one `request()`.

## 4. Migration plan

1. Add `api.admin.oracleSigners.{active,propose,approve,execute}` and
   `api.notifications.setThresholds(importerId, body)` to `lib/api.ts`,
   matching the real `apps/api` routes (confirm the paths; the current relative
   paths may be relying on a rewrite).
2. Switch `OracleSignerRotation.tsx`, `HealthScore.tsx` and
   `TariffRateChart.tsx` to those methods, one PR each or one small PR total.
3. Add an ESLint `no-restricted-globals`/`no-restricted-syntax` rule for
   `fetch` in `apps/web/{app,components}/**`, with `lib/**` exempt. Put it in
   `packages/eslint-config` so it is enforced in CI.
4. Add `request()` tests for network failure and non-JSON error bodies to
   `lib/api.test.ts`.
5. Document the rule in `ARCHITECTURE.md` and `CONTRIBUTING.md`.

Steps 1-2 are mechanical (5 call sites); step 3 is what keeps it from regressing.

## 5. Trade-offs

**For enforcing:** one place for auth, base URL, retries and errors; consistent
`ApiError` UX; easier mocking in tests (mock one module); prevents credential
leakage to non-API hosts.

**Against:** a one-time refactor of ~6 call sites; a growing `api.ts` needs
splitting; the lint rule is a small ongoing maintenance cost; contributors
must add a client method before a component can call a new endpoint.

**Rejected alternative:** routing web→API through `packages/sdk`. The SDK is a
contract-integration surface. Coupling it to REST would pull Soroban
dependencies into every page bundle and blur the two ownership domains.
