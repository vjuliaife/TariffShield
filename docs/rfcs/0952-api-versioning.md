# RFC 0952: Path-prefix API versioning for `apps/api`

- Status: Proposed
- Issue: #952

## Summary

Adopt a mandatory `/v{N}` path prefix for all non-internal API routes, mounted
through a single version registry in `apps/api/src/versioning.ts`, and extend
`packages/sdk/src/compatibility.ts` so SDK releases declare which API major
versions they support. The prefix is introduced as an **alias** — every existing
unversioned path keeps working — and a deprecation/sunset policy governs how
long the alias lives.

The prefix is not a proposal about taste. The repo already contains 3
half-adopted prefixes that disagree with each other, ~50 route comments that
document a prefix that does not exist, and an OpenAPI file that is the "source
of truth" per the README but describes a server that has never been deployed.
Versioning is the cheapest available fix for a divergence that is already
costing real debugging time.

## 1. Audit of current state

### 1.1 The mount table

`apps/api/src/index.ts:336-368` contains 34 `app.use()` mounts (32 routers plus
2 rate limiters at lines 336-337). Exactly **two** carry a version segment:

| Line | Mount | Router |
| --- | --- | --- |
| 350 | `/account/api-keys` | `apiKeysRouter` |
| **351** | **`/api/v1/account/api-keys`** | `apiKeysRouter` (same router, second mount) |
| **364** | **`/api/v1/regulatory`** | `regulatoryRouter` (only mount; no unversioned twin) |
| 366 | `/api` | `bondSignaturesRouter` (an `/api` prefix, not a version) |

The remaining 31 mounts are unversioned, including the high-traffic groups
`/importers` (5 routers share this prefix, lines 339-343), `/admin` (2 routers,
344 and 347), `/account` (2 routers, 348-349) and `/surety-marketplace`
(2 routers, 367-368).

Three distinct prefix styles are therefore live at once:

1. **none** — `/importers`, `/admin`, `/account`, …
2. **`/api/v1`** — `/api/v1/regulatory`, `/api/v1/account/api-keys`
3. **`/api`** — `/api/bonds/*` via line 366

There is no rule that produced this, and no way to tell from a URL alone which
style a given endpoint follows.

### 1.2 The documentation already assumes `/api/v1`, and is wrong

8 route files document `/api/v1/...` paths in their header comments — **52
occurrences**:

| File | Occurrences |
| --- | --- |
| `routes/compliance.ts` | 22 |
| `routes/bond-signatures.ts` | 10 |
| `routes/kyc.ts` | 6 |
| `routes/surety-marketplace.ts` | 5 |
| `routes/privacy.ts` | 3 |
| `routes/erasure.ts` | 3 |
| `routes/tos.ts` | 2 |
| `routes/regulatory.ts` | 1 |

Only the `regulatory.ts` one is real. For example `routes/bond-signatures.ts:4-6`
advertises `POST /api/v1/bonds/:id/send-for-signature` while the actual URL is
`/api/bonds/:id/send-for-signature` (mount at line 366 + internal path at
`bond-signatures.ts:57`). All 22 `/api/v1` comments in `compliance.ts` describe
routes mounted at `/compliance`.

`apps/api/src/auth.ts` inherits the same drift: line 55 lists
`'GET /api/v1/regulatory/state-report/:state_code'` (correct, it is the one
versioned mount) while line 315 lists `'POST /api/v1/account/accept-tos'`, which
is actually served at `/account/accept-tos` (mount line 349). The same constant
is simultaneously right and wrong one line apart.

Operational docs repeat it: `docs/runbooks/support-escalation.md` issues 7 curl
commands against `/api/v1/importers/...`, `/api/v1/auth/me` and
`/api/v1/importers/:id/auto-top-up` (lines 52, 76, 97, 100, 160, 278, 282, 297).
**None of them resolve.** An on-call engineer following the support-escalation
runbook gets 404s from the eight commands that runbook depends on. The same file
uses the correct unversioned `/health` at line 274.

### 1.3 A router that is defined, gated, and never mounted

`routes/erasure.ts` builds `erasureRouter` (line 11), attaches `authMiddleware`
plus `privacyReacceptanceGate` and `tosReacceptanceGate` (lines 12-14), and
registers 5 routes. It is **never imported into `index.ts`** — the only
references to `erasureRouter` in the repo are inside `erasure.ts` itself.

Yet `ROLE_PERMISSIONS.importer` (`auth.ts:27-28`) documents
`POST /account/erasure-request` and `GET /account/erasure-request/:id` as
granted permissions, and `apps/api/tests/benchmarks/erasure-scaling.js:22`
benchmarks `/account/erasure-request`. The GDPR erasure endpoint that the
matrix advertises and the benchmark measures is not reachable over HTTP.

This is a versioning-shaped bug: an endpoint was written against a future
`/api/v1/erasure` mount, the mount was never added, and nothing failed.

### 1.4 Consumers

Three distinct consumer populations, all unversioned:

| Consumer | Base URL source | Version prefix | Call sites |
| --- | --- | --- | --- |
| `apps/web/lib/api.ts` | `NEXT_PUBLIC_API_URL` (default `http://localhost:3002`), line 5-6 | none | 56 `request()` calls / 46 distinct routes |
| `packages/sdk` (`TariffShieldApiClient`) | caller-supplied `apiUrl`/`baseUrl` | none | 11 `request()` calls / 10 distinct routes |
| `scripts/e2e.ts`, k6 suites, CI, monitoring, Postman | assorted | none (1 exception, below) | see below |

`apps/web` reaches the API through exactly one module, `lib/api.ts`, whose
`request()` does a single `fetch` at line 117 with **no path normalization** —
the version segment would have to be added either by the caller or by that
function.

`packages/sdk` is *both* a Soroban library and an HTTP client. `TariffShieldApiClient`
(`packages/sdk/src/index.ts:56-170`) has one `fetch` at line 86 and builds URLs
at line 81 as `` `${this.baseUrl}${path}` `` — again no version injection.
`TariffShieldClient` constructs it only when `opts.apiUrl` is set (lines 210-216),
exposed as `public readonly api?`. This is the seam the SDK compatibility check
should key off.

Other consumers, for completeness:

- `scripts/test-regulatory-report.ts` is the **only** consumer already using a
  version prefix (lines 103, 113, 119, 129 use `/api/v1/regulatory/...`), and it
  is correct — because that is one of the two versioned mounts. It is
  accidentally right.
- `docs/tariff-shield.postman_environment.json:8` sets
  `base_url = http://localhost:3001/api/v1`. All 13 requests in the companion
  collection therefore resolve to `http://localhost:3001/api/v1/auth/signup`
  and similar. **Wrong port (3001, not 3002) and an unmounted prefix.** Every
  request in the collection 404s as shipped.
- `docs/api/openapi.yml:7,9` is the only OpenAPI artifact with a version in
  `servers:` (`https://api.tariffshield.com/v1`). It describes 5 paths. The spec
  actually **served** at `GET /docs/openapi.json` is
  `apps/api/src/docs/openapi.ts` (1250 lines, 44 paths, `servers:` at lines
  15-18 with **no** version). `README.md:235` calls the 5-path file "the source
  of truth OpenAPI 3.x specification" and line 248 tells contributors to edit
  it. The authoritative-by-documentation spec is the one that does not match
  the server.
- `docs/compliance-escalation-and-marketplace.md:148,154,162,166` targets port
  3001.

### 1.5 Nine dead client call sites

`apps/web` contains 9 `fetch` calls outside `lib/api.ts`, all browser-relative
`/api/...` paths that bypass `NEXT_PUBLIC_API_URL`, the bearer token and
`ApiError`:

- `components/OracleSignerRotation.tsx:29,60,85,105` — `/api/admin/oracle-signers/*`
- `components/TariffRateChart.tsx:30` — `/api/importers/:id/tariff-history`
- `components/HealthScore.tsx:83,288` — `/api/notifications/thresholds/:id`, `/api/importers/:id/peer-benchmark`
- `components/Nav.tsx:31,45` — **`/api/v1/changelog`** and `/api/v1/changelog/:id/read`

`apps/web` has no proxy for these: `next.config.ts` defines no `rewrites()`,
there is no `app/api/` route handler anywhere in the tree, and there is no
middleware. Every one of these requests hits the Next.js origin on `:3000` and
404s.

`Nav.tsx:31,45` are the only `/api/v1` strings in the whole `apps/web` tree,
and **`changelog` matches no route in `apps/api` at all** — it is an
unimplemented feature that happens to be spelled in the versioned style this RFC
proposes. The comments at `Nav.tsx:38-40` ("Graceful fallback for offline /
stub environment") are the only acknowledgement in the repo that these calls
never succeed.

## 2. Proposed scheme

**Path prefix, mandatory, `/v{N}` as the first path segment after the host.**

```
https://api.tariffshield.com/v1/importers/:id
https://api.tariffshield.com/v1/admin/audit-log
https://api.tariffshield.com/v1/compliance/flags
```

Rejected alternative — **header-based** (`Accept: application/vnd.tariffshield.v1+json`).
It leaves URLs clean, but this repo has three independent clients (web bundle,
SDK, k6/CI) plus a Postman collection and a ZAP DAST job. Content negotiation
is invisible in logs, in the Prometheus `route` label computed at
`index.ts:231` from `req.baseUrl + req.route.path`, in k6 assertions, and in
`curl` by a human on an incident. The version needs to be the most greppable
token in the system, and it needs to survive being pasted into Slack.

### 2.1 One version, one prefix style

Adopt `/v1` — **not** the current `/api/v1`. `/api` is already doing two
unrelated jobs: it is the mount for `bondSignaturesRouter` (line 366) and it is
the second segment of the two ad-hoc versioned mounts. Keeping it would preserve
the ambiguity this RFC exists to remove. `/v1` also matches
`packages/sdk/src/compatibility.ts`, whose contract versions are `v0_1_0`
style — one convention, repo-wide.

The three existing `/api/v1` mounts are migrated to `/v1`, with the old prefix
kept as a redirect alias for one deprecation window (§4).

### 2.2 A single mount registry

Route mounting moves out of `index.ts` into `apps/api/src/versioning.ts`:

```ts
// apps/api/src/versioning.ts
export const API_MAJOR_VERSION = 1;
export const API_VERSIONS = [1] as const;

type RouterEntry = { prefix: string; router: Router; internal?: boolean };

// The whole public surface, declared once. index.ts mounts this list; the
// deprecation middleware and the SDK compatibility check both read it.
export const V1_ROUTES: RouterEntry[] = [
  { prefix: '/auth', router: authRouter },
  { prefix: '/importers', router: importersRouter },
  { prefix: '/importers', router: kycRouter },
  { prefix: '/importers', router: supportTicketsRouter },
  { prefix: '/importers', router: brokerRouter },
  { prefix: '/importers', router: htsLookupRouter },
  { prefix: '/importers', router: erasureRouter },        // was never mounted
  { prefix: '/admin', router: adminSupportTicketsRouter },
  { prefix: '/admin', router: adminRouter },
  { prefix: '/compliance', router: complianceRouter },
  { prefix: '/compliance-report-links', router: complianceReportLinksRouter },
  { prefix: '/account', router: privacyRouter },
  { prefix: '/account', router: tosRouter },
  { prefix: '/account/api-keys', router: apiKeysRouter },
  { prefix: '/surety-license', router: suretyLicenseRouter },
  { prefix: '/regulatory', router: regulatoryRouter },
  { prefix: '/notifications', router: notificationsRouter },
  { prefix: '/upgrade-subscriptions', router: upgradeSubscriptionsRouter },
  { prefix: '/bond-annotations', router: bondAnnotationsRouter },
  { prefix: '/sla', router: slaRouter },
  { prefix: '/developer', router: developerRouter },
  { prefix: '/onboarding', router: onboardingRouter },
  { prefix: '/nps', router: npsRouter },
  { prefix: '/report-templates', router: reportTemplatesRouter },
  { prefix: '/branding/public', router: brandingPublicRouter },
  { prefix: '/branding', router: brandingRouter },
  { prefix: '/bonds', router: bondWebhookRouter },
  { prefix: '/bonds', router: bondSignaturesRouter },      // was mounted at /api
  { prefix: '/surety-marketplace', router: suretyMarketplaceRouter },
  { prefix: '/surety-marketplace', router: adminMarketplaceRouter },
];
```

`index.ts` becomes:

```ts
for (const version of API_VERSIONS) {
  app.use(`/v${version}`, buildVersionedRouter(version));
}
```

Three properties follow, and each replaces a specific defect above:

- **`erasureRouter` is now in the list**, so §1.3 cannot recur silently. The
  registry is the mount table; a router that is not in it is not served, and
  `scripts/check-route-mounts.ts` (below) fails the build on any exported
  router missing from it.
- **`bondSignaturesRouter` moves from `/api` to `/bonds`**, so the 10
  `/api/v1/bonds/...` comments in `bond-signatures.ts` become true.
- **One list means the version cannot drift per-router.** The `/api/v1/regulatory`
  vs `/compliance` split has no mechanism to express itself.

### 2.3 Concrete example: one route, rewritten

`GET /admin/audit-log` today, at `routes/admin.ts:36`:

```ts
adminRouter.get('/audit-log', requireRole('surety_admin'), async (req, res) => { ... });
```

Mounted by `index.ts:347` as `app.use('/admin', adminRouter)`. Served at
`GET /admin/audit-log`.

After:

```ts
// apps/api/src/versioning.ts
{ prefix: '/admin', router: adminRouter },
```

```ts
// apps/api/src/index.ts
app.use('/v1', buildVersionedRouter(1));
```

```ts
// apps/web/lib/api.ts — one change, all 46 routes fixed
const res = await fetch(`${BASE}/v1${path}`, { ... });
```

```ts
// packages/sdk/src/index.ts — one change, all 10 routes fixed
const url = `${this.baseUrl}/v1${path.startsWith('/') ? path : `/${path}`}`;
```

Served at `GET /v1/admin/audit-log`. The route file does not change; the client
changes in one line each because both already funnel every request through a
single `request()`.

### 2.4 What stays unversioned

Deliberately outside `/v{N}`:

| Path | Reason |
| --- | --- |
| `/health`, `/metrics`, `/health/live`, `/health/ready` | probed by `monitoring/uptime/monitors.yaml`, `deploy-api.yml:28,51`, the k6 CI gate (`benchmark.yml:94`) and the DAST job. Versioning a liveness probe buys nothing and risks a probe that 404s during a rollout. |
| `/docs`, `/docs/openapi.json` | Swagger UI must be able to describe multiple versions at once. |
| `/bonds/docusign-webhook` | third-party (DocuSign) callback URL. Its URL is registered in the DocuSign admin console by a human; changing it is a support action, not a deploy. Keep it permanently unversioned and note the exception. |
| `/api/v1/*` (legacy alias) | §4 sunset window only. |

## 3. Extending `packages/sdk/src/compatibility.ts`

Today the matrix maps an **SDK version to a contract version range**
(`compatibility.ts:8-12`):

```ts
export const COMPATIBILITY_MATRIX: Record<string, ContractVersionRange> = {
  '0.1.0': { minContract: 'v0_1_0', maxContract: 'v0_3_0' },
  '1.0.0': { minContract: 'v0_1_0', maxContract: 'v0_1_0' },
  '1.1.0': { minContract: 'v0_1_0', maxContract: 'v0_2_0' },
};
```

`checkCompatibility(contractVersion, sdkVersion)` (line 44) throws
`CompatibilityError` when the deployed contract is outside the range for the
SDK the caller is using. The header comment (line 1) states the process: every
contract upgrade must add an SDK entry before the contract ships.

The contract dimension stays exactly as it is. What is added is a second,
independent axis — **which API major versions this SDK speaks** — because an SDK
release and an API deployment are released independently and one does not
constrain the other. Adding `minApi`/`maxApi` to `ContractVersionRange` would be
wrong: it would imply an SDK is compatible with contract `v0_2_0` *because* it
speaks API `v1`, which is not a real relationship.

```ts
// packages/sdk/src/compatibility.ts (additions)

export interface ApiVersionRange {
  minApi: number;
  maxApi: number;
}

/** API major versions each SDK release is written against. */
export const API_COMPATIBILITY_MATRIX: Record<string, ApiVersionRange> = {
  '1.0.0': { minApi: 1, maxApi: 1 },
  '1.1.0': { minApi: 1, maxApi: 1 },
  '1.2.0': { minApi: 1, maxApi: 2 },   // first SDK to speak /v2
};

export class ApiCompatibilityError extends Error {
  constructor(
    public readonly sdkVersion: string,
    public readonly serverVersion: number,
    public readonly supported: ApiVersionRange,
  ) {
    super(
      `SDK version ${sdkVersion} supports API v${supported.minApi}..v${supported.maxApi}, ` +
        `but the server is v${serverVersion}. ` +
        `Upgrade the SDK, or pin the server to a supported major.`
    );
    this.name = 'ApiCompatibilityError';
  }
}

export function checkApiCompatibility(serverVersion: number, sdkVersion: string): void {
  const range = API_COMPATIBILITY_MATRIX[sdkVersion];
  if (!range) {
    throw new ApiCompatibilityError(sdkVersion, serverVersion, { minApi: -1, maxApi: -1 });
  }
  if (serverVersion < range.minApi || serverVersion > range.maxApi) {
    throw new ApiCompatibilityError(sdkVersion, serverVersion, range);
  }
}
```

### 3.1 Where the server version comes from

The client must be able to discover the version without a request, so
`TariffShieldApiClient` defaults to `v1` and the check runs only when the caller
opts in:

```ts
export interface TariffShieldApiOptions {
  baseUrl: string;
  apiKey?: string;
  sessionToken?: string;
  /** API major this client speaks. Default 1 — the first versioned release. */
  apiVersion?: number;
  /** Throw ApiCompatibilityError when the server's major is unsupported. */
  strictApiVersion?: boolean;
}
```

The server advertises its version on every response, so a mismatch surfaces on
the first call rather than the tenth:

```ts
// apps/api/src/versioning.ts
app.use((req, res, next) => {
  res.set('X-API-Version', String(API_MAJOR_VERSION));
  res.set('Deprecation', 'true');                       // only on the alias
  res.set('Sunset', 'Wed, 31 Dec 2026 00:00:00 GMT');   // only on the alias
  next();
});
```

`strictApiVersion` compares `X-API-Version` against `API_COMPATIBILITY_MATRIX`
and throws `ApiCompatibilityError`. It defaults to `false` so that a server
rolling forward to `v2` does not break every existing SDK call on the day
`v2` ships — which is the entire reason the alias exists (§4).

### 3.2 CI enforcement

The matrix only helps if it cannot go stale. `scripts/check-contract-version.ts`
already exists for the contract axis; add `scripts/check-api-version.ts`:

1. `V1_ROUTES` (or `V2_ROUTES`) is non-empty and mounts **every** router
   exported from `apps/api/src/routes/*.ts` — the check that would have caught
   `erasureRouter`.
2. No `app.use('/...` in `index.ts` outside the registry — route mounting is
   only possible via `versioning.ts`.
3. Every SDK version in `packages/sdk/package.json` history that `index.ts`
   re-exports has an `API_COMPATIBILITY_MATRIX` row.
4. Every path literal in the served OpenAPI spec starts with `/v{N}` for some
   declared `N`, and `servers:` carries no version segment (the version is in
   the paths, per §2.1).
5. `apps/web/lib/api.ts` prepends the version exactly once — a guard against
   both the double-prefix (`/v1/v1/...`) and zero-prefix regressions.

Point 5 matters more than it looks: 9 web call sites already use relative
`/api/...` paths (§1.5), so the prefix convention needs a mechanical check, not
a convention.

## 4. Deprecation and sunset policy

**Version bump triggers.** A new major is cut only when a change is breaking:
a response field is removed or renamed, a field's type changes, a required
request field is added, an endpoint is removed or its path changes, or a route
gains an auth requirement. Adding an optional response field, adding an
optional request field, and adding a new endpoint are all non-breaking and
ship inside the current major.

| Stage | Minimum duration | Action |
| --- | --- | --- |
| `v{N+1}` merged | — | Both majors mounted. `v{N}` is the default; `v{N+1}` is opt-in. |
| Announce | 0 | `docs/api/CHANGELOG.md` entry, RFC merged, `API_COMPATIBILITY_MATRIX` row added. |
| Deprecation headers | day 0 | `v{N}` responses carry `Deprecation: true` + `Sunset: <HTTP-date>`. Minimum **90 days**. |
| Client migration | 0-90 | `apps/web` and `packages/sdk` move to `v{N+1}`. `v{N+1}` must reach GA before day 90. |
| Sunset | day 90 | `v{N}` removed from `API_VERSIONS`. Only safe once `v{N+1}` is GA. |
| Alias removal | +90 days after sunset | Unversioned paths stop redirecting. |

**Unversioned alias.** While any client may still be unversioned, every
unversioned path stays live as a permanent alias that resolves to the current
major, logging one deprecation warning per route per hour:

```ts
app.use(unversionedAliasRouter);   // -> current major, sets Deprecation + Sunset
```

This is the migration mechanism, not a permanent state. It is scheduled for
removal, and `check-api-version.ts` fails once the grace period lapses, so it
cannot quietly become permanent. Unlike a hard cut, it makes the migration
**observable**: Prometheus can alert on
`sum(rate(deprecation_warning_total[1h])) > 0`, so "who is still unversioned"
becomes a dashboard instead of a support ticket.

**Per-client policy.** The web app is first-party and deploys with the API, so
it moves in one PR. The SDK is published to third parties and cannot be forced,
so `API_COMPATIBILITY_MATRIX` is how we learn about it: an SDK release that
declares `maxApi: 1` against a `v2` server raises `ApiCompatibilityError` in
`strictApiVersion` mode, and that is the signal to extend the sunset window
rather than remove the version.

**Version skew rules.**

- `v{N}` and `v{N+1}` write to the same schema. `v{N+1}` breaking changes must
  be additive at the database level (new nullable column, new table) so the old
  version stays coherent. This is the same discipline
  `apps/api/src/db.ts` already uses for its `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` migrations.
- Migrations run at boot (`index.ts:383`, `await migrate()` when not production).
  Rolling deploys must not require the new major's columns to exist for the old
  major to serve traffic.

## 5. Migration plan

Each step is independently shippable and independently revertable. Steps 1-2
are pure additions.

1. **Add `apps/api/src/versioning.ts` with the registry**, and mount
   `app.use('/v1', buildVersionedRouter(1))` alongside every existing unversioned
   mount. Both work; nothing breaks. Include `erasureRouter` here and open a
   separate issue for the fact that it was unreachable.
2. **Move `bondSignaturesRouter` from `/api` to `/v1/bonds`**, keeping `/api/bonds`
   as a 307 redirect for one release. Fixes 10 false comments.
3. **Add `scripts/check-api-version.ts`** to CI with checks 1, 2 and 5 above.
   From here the registry cannot drift.
4. **Point clients at `/v1`.** One line in `apps/web/lib/api.ts` (line 117) and
   one in `packages/sdk/src/index.ts` (line 81). Update
   `scripts/test-regulatory-report.ts` and the k6 `setup.js` base paths in the
   same PR.
5. **Add `API_COMPATIBILITY_MATRIX` + `checkApiCompatibility`** to
   `packages/sdk/src/compatibility.ts`, with `strictApiVersion` defaulting off.
   Add `scripts/check-api-version.ts` checks 3 and 4.
6. **Reconcile the specs and docs.** Make `apps/api/src/docs/openapi.ts` the one
   spec, re-prefix its 44 paths to `/v1`, fix `README.md:235,248`, delete or
   rewrite `docs/api/openapi.yml`, fix the 8 curl commands in
   `docs/runbooks/support-escalation.md`, and correct
   `docs/tariff-shield.postman_environment.json:8` to
   `http://localhost:3002/v1`.
7. **Fix the 9 dead `apps/web` call sites** (§1.5) — route them through
   `lib/api.ts`. Until this lands, `Nav.tsx` should call an endpoint that
   exists or the changelog feature should be flagged as unimplemented; shipping
   `/api/v1/changelog` invites the belief that `/api/v1` is already live.
8. **Sunset.** After 90 days at GA, drop `v1` from `API_VERSIONS` when `v2`
   ships. Separately, remove the unversioned alias once
   `deprecation_warning_total` is flat at zero.

## 6. Trade-offs

**For versioning now.**

- The divergence is already expensive and growing: ~50 wrong route comments, a
  runbook whose 8 commands 404, a Postman collection that cannot work, and two
  OpenAPI specs where the documented-authoritative one is wrong. Versioning
  forces the mount table into one list, which is the actual fix for all four.
- Consumers funnel through 2 chokepoints (`lib/api.ts:117`,
  `packages/sdk/src/index.ts:81`). A version prefix is a 2-line change, not the
  67-call-site change it looks like from the URL count.
- The Prometheus `route` label (`index.ts:231`) becomes version-aware for free
  once the prefix is in `req.baseUrl`, so we can finally see which clients are
  on which major.
- The alias + deprecation-header design means **no forced simultaneous deploy**.
  That is the trade-off named in the issue, and it is genuinely eliminated
  rather than deferred.

**Against.**

- Two live surfaces during the window. Every route needs a test against both
  majors, so the route test matrix roughly doubles while `v1` and `v2` coexist.
  This is the largest real cost and it is why the sunset window is a hard
  90-day floor rather than "whenever".
- Two OpenAPI specs exist today; this RFC does not fix that, it fixes the
  mounted surface. Leaving the stale `docs/api/openapi.yml` in place while
  claiming versioning is "done" would be worse than not starting, so step 6 is
  not optional.
- A prefix is a breaking change for the 9 already-broken relative `/api/...`
  call sites in a way that could mask their breakage — they were 404ing before
  and would 404 after, for a different reason. Step 7 exists to keep that
  visible.

**Rejected: stay unversioned with coordinated deploys.** This is the status
quo and it is the honest alternative. Its real cost is not the deploy
coordination — that is manageable for two first-party clients — but that
"breaking change" becomes an unanswerable question. There is no artifact that
says which response shapes a given SDK release can parse, and no way to answer
"can I rename this field?" without reading every client. The repo's answer to
that question today is 52 comments that document paths the server does not
serve, which is what drift looks like when nothing enforces it. Note the
coordinated-deploy model also does not help third parties: `TariffShieldApiClient`
is published, and no deploy we perform can coordinate with an SDK a customer
pinned 8 months ago. Versioning plus `API_COMPATIBILITY_MATRIX` is the only
mechanism in the design that puts that case on an explicit, testable footing.

**Rejected: `Accept:` header versioning.** Cleaner URLs; worse for a system with
9 scripts and CI jobs, a Prometheus `route` label derived from the path, and an
on-call engineer debugging with `curl`. Rejected for observability, not taste.

## 7. Open questions

1. Does `/v1` conflict with the `/api` mount that `bondSignaturesRouter` needs,
   or should bond signatures keep a non-versioned `/bonds` namespace because the
   DocuSign callback sits in the same router? (Proposal: version the callback
   out of scope, version the rest.)
2. Should `packages/sdk` default `apiVersion` to `1` forever, or should a
   future `2.0.0` break the default to `2` and make the bump explicit at the
   type level?
3. Who owns retiring the unversioned alias — a fixed date, or a metric gate
   (`deprecation_warning_total == 0` for 30 consecutive days)? The metric gate
   is safer; the fixed date is enforceable by CI.
