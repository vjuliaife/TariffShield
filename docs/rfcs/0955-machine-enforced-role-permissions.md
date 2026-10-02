# RFC 0955: Machine-enforce the `ROLE_PERMISSIONS` matrix

- Status: Proposed
- Issue: #955

## Summary

Keep the matrix as documentation, but stop calling it a source of truth, and add
a CI check that fails when it and the route definitions disagree. The check must
understand **four** authorization mechanisms, because routes use four — and the
one an auditor would most want verified (the 58-call `loadImporterFor` helper)
is the one a `requireRole` grep cannot see.

The audit also found that the matrix documents three endpoints that do not
exist, mis-states the HTTP method on a fourth, and omits an unreviewed
surety-license endpoint entirely.

## 1. Audit: the current relationship

### 1.1 Nothing reads the matrix

```
$ grep -rn "ROLE_PERMISSIONS" --include=*.ts --include=*.md .
apps/api/src/auth.ts:14:export const ROLE_PERMISSIONS = {
docs/security/soc2-cc6-controls.md:58:The authoritative access matrix constant is in …
```

**Two references: its own declaration, and one Markdown file.** No route, no
middleware, no test, no script reads it. The issue's premise is confirmed
exactly: the comment at `auth.ts:12-13` calls it "the authoritative source of
truth for auditors; keep it in sync with route definitions", and "keep it in
sync" is currently a human obligation with no feedback loop.

### 1.2 Coverage: 45 documented entries against 231 registered routes

| | Count |
| --- | --- |
| Route registrations across `apps/api/src/routes/*.ts` | **231** |
| `ROLE_PERMISSIONS` entries (`auth.ts:15-69`) | **45** |
| — `importer` | 15 |
| — `surety_admin` | 26 |
| — `broker` | 4 |
| — `admin` | 1 (prose, not a route) |

So the matrix describes **~19% of the surface**. The largest route files are
undocumented: `importers.ts` (73 routes), `compliance.ts` (22), `admin.ts` (22),
`auth.ts` (14), `bond-signatures.ts` (10). The whole `/notifications` group (7),
`/developer` (3), `/nps` (4), `/onboarding` (4), `/report-templates` (2),
`/bond-annotations` (5), `/branding` (4) and `/api-keys` (5) are absent.

### 1.3 Enforcement uses four distinct mechanisms

This is the finding that determines the design. A check built on
`grep requireRole` would be wrong for three of the four.

**(a) `requireRole(role)` middleware — 41 call sites**

`auth.ts:233-242`, a 10-line factory. Distribution:

| Role | Calls | Files |
| --- | --- | --- |
| `surety_admin` | 37 | `admin.ts` (20), `bond-signatures.ts` (6), `kyc.ts` (2), `onboarding.ts` (2), `branding.ts`, `compliance.ts`, `nps.ts`, `regulatory.ts`, `report-templates.ts`, `sla.ts`, `surety-marketplace.ts` (1 each) |
| `importer` | 3 | `broker.ts` (all 3) |
| `broker` | 1 | `broker.ts` |

Note that all three `requireRole('importer')` sites are in `broker.ts`
(26, 67, 86) — importer routes rely on `loadImporterFor` instead, which is
§1.3c.

**(b) Inline role comparisons — 39 sites**

Hand-written `if (user.role !== 'surety_admin') { … }` inside handlers. By file:
`importers.ts` (19), `bond-annotations.ts` (6), `kyc.ts` (4),
`support-tickets.ts` (3), `surety-license.ts` (2), `admin.ts` (2),
`notifications.ts` (1), `bond-signatures.ts` (1), `auth.ts` (1).

**Concrete case where (b) hides a correct gate from (a):**
`admin.ts:167` (`GET /oracle-alerts`) and `admin.ts:193`
(`PATCH /oracle-alerts/:id/acknowledge`) both enforce `surety_admin` correctly —
but inline, at lines 168-171 and 194-197:

```ts
adminRouter.get('/oracle-alerts', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return;
  }
```

The matrix documents both as `surety_admin` (`auth.ts:39-40`) and the code agrees.
A naive CI check would report two false "missing `requireRole`" failures and be
either ignored or disabled. **A check must verify enforcement semantics, not the
presence of one specific function.**

**(c) `loadImporterFor` — 58 call sites, the real authorization chokepoint**

`importers.ts:734-777`. This is where most importer authorization actually
happens, and the matrix models none of it:

```ts
async function loadImporterFor(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  if (user.apiKeyId && user.importerId) {          // axis 1: API-key scoping (#995)
    if (importerId !== user.importerId) return null;
  }
  if (user.role === 'surety_admin') { … return row }        // axis 2: role
  if (user.role === 'broker') {                              // axis 3: delegated grant
    if (req.method !== 'GET') return null;
    const granted = await hasActiveBrokerGrant(user.id, importerId);
    if (!granted) return null;
    …
  }
  const r = await pool.query(                            // axis 4: team membership
    `SELECT i.*,
            CASE WHEN i.user_id = $2 THEN 'owner' ELSE tm.role::text END as member_role
     FROM importers i
     LEFT JOIN importer_team_members tm
       ON tm.importer_id = i.id AND tm.user_id = $2 AND tm.status = 'active'
     WHERE i.id = $1 AND (i.user_id = $2 OR tm.user_id IS NOT NULL)`, …);
  const importer = r.rows[0];
  if (!importer) return null;
  if (importer.member_role === 'viewer' && req.method !== 'GET') return null;   // read-only
  return importer;
}
```

**58 of the 73 routes in `importers.ts` route their authorization through this
one function.** `ROLE_PERMISSIONS.importer` describes that behavior with 15 flat
strings and the qualifier `(own)`.

**(d) `requireLicenseVerified` — 2 call sites**

`surety-license.ts:33-52`, used at `importers.ts:3048` and `:3080`. It is a
*second dimension* on top of a role, not a role: a `surety_admin` must have a
verified license to invoke those routes, and the matrix encodes this as prose
inside the string — `'POST /importers/:id/accrue-yield (license-verified)'`
(`auth.ts:36`).

### 1.4 The matrix has one axis; the system has three

`AuthPayload['role']` (`auth.ts:87`) is `'importer' | 'surety_admin' | 'broker'`.
The matrix models exactly that. But real access decisions also depend on:

| Axis | Source | Values | In the matrix? |
| --- | --- | --- | --- |
| Auth role | `AuthPayload.role` | `importer`, `surety_admin`, `broker` | yes |
| Team membership | `importer_team_members.role` (enum `team_member_role`, migration `0016_importer_team_members.ts:7`) | `admin`, `finance`, `viewer` (+ synthetic `owner`) | **no** |
| Broker grant | `broker_importer_grants` with `revoked_at IS NULL` | granted / not granted | partially, as `(grant-scoped)` prose |

Two consequences.

**The `admin` role contradicts the matrix.** `auth.ts:60` reads
`admin: ['ALL — reserved for platform operator via direct DB or Stellar keypair operations']`
— i.e. the matrix asserts `admin` never appears in route enforcement. But two
inline checks test it: `importers.ts:819` and `:875`,
`if (importer.user_id !== user.id && importer.member_role !== 'admin')`. These
are `member_role`, not the auth role, which is exactly why the matrix's
one-axis shape cannot be reconciled with the code: an auditor reading
`ROLE_PERMISSIONS.admin` would conclude no route checks for `admin`, and two
routes do.

**`finance` has no rule.** The enum has `('admin', 'finance', 'viewer')`
(`0016_importer_team_members.ts:7`). `loadImporterFor` restricts only `viewer`
(line 772). `finance` therefore has full write access — same as `admin`, minus
the invite permission at line 819. Whether that is intended is undocumented,
and no artifact in the repo says. The matrix cannot express it either way.

### 1.5 Concrete divergences, present today

| # | Matrix says | Code says | Where |
| --- | --- | --- | --- |
| 1 | `GET /importers/own` | **no such route**; `/own` matches nothing in any router | `auth.ts:17` |
| 2 | `GET /importers/:id/kyc/:docId/review` | it is **`POST`** | `auth.ts:38` vs `kyc.ts:362-364` |
| 3 | `POST /account/erasure-request`, `GET /account/erasure-request/:id` | `erasureRouter` is **never mounted** in `index.ts` — unreachable over HTTP | `auth.ts:27-28` vs `index.ts:336-368` |
| 4 | (silent) | `PUT /surety-license/:id/review` has **no role gate at all** and no matrix entry | `surety-license.ts:137` |
| 5 | (silent) | `GET /surety-license` has **no role gate** and no matrix entry | `surety-license.ts:168` |
| 6 | `admin: ALL — reserved … via direct DB` | two routes check a role named `admin` | `auth.ts:60` vs `importers.ts:819,875` |

Divergence 2 is the one an auditor would care about most: the matrix says a
document **review** is a `GET`, and the code says it is a `POST` that changes
`kyc_status`. Read the matrix and you would believe there is a read-only review
endpoint; there is not, and the state-changing one is undocumented.

Divergence 3 is shared with RFC 0952 §1.3 — `erasureRouter` is built and gated
but never mounted, so a documented GDPR erasure endpoint does not exist over
HTTP.

Divergences 4-5 are the reverse kind: routes with **no** gate and **no**
documentation. `surety-license.ts:137` (`PUT /:id/review`) mutates a license
verification record. `POST /submit` and `GET /status` on that router use a
local `requireSuretyAdmin` (line 23), but the review and list routes do not, and
the matrix omits all four except the two it lists.

## 2. Proposal: CI verification, not generation

The issue offers two options. **Choose CI verification.**

**Why not generate the matrix from route metadata.** To generate a matrix, every
route must declare its own permissions as structured data — which means
rewriting registration for all 231 routes across 27 files, and expressing
mechanisms (b), (c) and (d) above as declarative metadata. Mechanism (c) alone
would need `loadImporterFor`'s four-axis decision modelled as a per-route
predicate, which is a re-implementation of the function, not a description of
it. Generation also cannot produce a *correct* matrix without a human deciding
what 186 undocumented routes are supposed to permit — so the first generated
matrix would be a guess, and a generated guess published as "the authoritative
access matrix for auditors" is worse than today's honest-but-stale list.

**Why verification is sufficient for the stated goal.** The risk the issue names
is audit-doc drift. Drift is prevented by a check that fails when the two
disagree, not by regenerating one from the other. Verification also degrades
gracefully: a route that opts out of the check is visible, whereas a generation
pipeline that silently misses a route pattern produces a confidently wrong
document.

### 2.1 The check: `scripts/check-role-permissions.ts`

Runs in CI. **Additive-only enforcement**: a new mismatch fails, and the
existing six divergences (§1.5) are recorded in a committed baseline file so
the check is green on day one and cannot be made green by deleting the baseline
entry in the same PR that introduces a new one.

**Rule 1 — every `requireRole('X')` route is documented for `X`.**
Parse `requireRole('<role>')` in the middleware position of a
`Router.<method>('<path>'` call. Resolve the full path through the mount table.
For each, assert a `ROLE_PERMISSIONS` entry matches method + path (normalising
`:param` and tolerating the `(own)` / `(all)` / `(grant-scoped)` suffixes).

**Rule 2 — every inline role check is documented, and the check must know the
difference.** Recognise `user.role !== '<role>'` and `user.role === '<role>'`
inside a handler and treat it as enforcement of `<role>`. This is what makes
`admin.ts:167,193` pass instead of failing (§1.3b). A route with *no*
recognisable enforcement primitive is reported as `UNDECLARED`, not as
`UNGUARDED` — many routes are correctly guarded by `loadImporterFor`, and
conflating "we cannot see the gate" with "there is no gate" would produce noise
that gets the check disabled.

**Rule 3 — every documented entry resolves to a real route.**
The inverse of rule 1, and it catches divergences 1, 2 and 3 directly. This is
the highest-value rule: it needs no knowledge of enforcement mechanisms at all,
only of the mount table plus the route regexes. Divergence 2 (wrong method)
fails because `GET` and `POST` are compared; divergence 1 (nonexistent route)
fails because nothing resolves; divergence 3 fails because `erasureRouter` is
absent from the mount table.

**Rule 4 — mount-table completeness.** Every router exported from
`apps/api/src/routes/*.ts` must appear in `index.ts`'s mount table. This is the
rule that would have caught `erasureRouter`, and it is shared with RFC 0952
step 3.

**Rule 5 — no unguarded mutating route.** For `POST`/`PUT`/`PATCH`/`DELETE`,
require at least one recognised primitive: `requireRole`, an inline role check,
`requireLicenseVerified`, or a `loadImporterFor` call in the handler. Catches
divergences 4-5. `GET` routes are exempt — a list endpoint that leaks
low-sensitivity data is a different (and largely unaudited) risk.

**Rule 6 — matrix hygiene.** Every entry is a parseable
`<METHOD> <path> (<qualifier>)?` string. Today the entries are free text with
bare paths (`'GET /importers/* (all)'` at `auth.ts:33` is not a resolvable
path), so rule 6 needs a normalisation pass before rule 3 can run at all. That
is deliberate work: it forces the matrix to become machine-readable, which is
the whole prerequisite for verification.

### 2.2 What passing and failing look like

Baseline: `scripts/role-permissions-baseline.json`, committed, listing the six
known divergences with a `since` field. Generated by `--update-baseline`, and
CI fails if a PR both adds an entry and does not reduce the file.

**Failing — new route with no matrix entry.** A PR adds
`adminRouter.post('/collateral-sweep', requireRole('surety_admin'), …)`:

```
$ npm run check:role-permissions

check-role-permissions: 231 routes, 45 matrix entries, 6 baselined divergences

FAIL rule=rule1 route=POST /admin/collateral-sweep role=surety_admin
  requireRole('surety_admin') on POST /admin/collateral-sweep is not documented
  in ROLE_PERMISSIONS.surety_admin (auth.ts:32-59).
  Add: 'POST /admin/collateral-sweep'
  or:  scripts/check-role-permissions.ts --update-baseline   (not allowed in the
       same PR that introduces the route)

1 error, 0 baselined errors matched, 231 routes checked
```

Note the last line: `--update-baseline` is refused when the baseline grew. That
is the mechanism that stops the check decaying into a suppression list.

**Failing — a route silently lost its gate.** A PR changes
`admin.ts:36` from `requireRole('surety_admin')` to a bare handler:

```
FAIL rule=rule5 route=GET /admin/audit-log method=GET
  no recognised authorization primitive on GET /admin/audit-log
  (expected one of: requireRole(...), inline role check, requireLicenseVerified,
   loadImporterFor)
  NOTE: this route was guarded before — see git blame. Was the guard intentional?
```

**Failing — matrix entry with no route** (rule 3), the divergence-1 shape:

```
FAIL rule=rule3 matrix="GET /importers/own" role=importer
  no route in the mount table resolves GET /importers/own
  (declared at auth.ts:17; importers.ts has 73 routes, none match)
```

**Failing — method drift** (rule 3, divergence 2):

```
FAIL rule=rule3 matrix="GET /importers/:id/kyc/:docId/review" role=surety_admin
  matrix declares GET but the only matching route is POST
  (routes/kyc.ts:364, guarded by requireRole('surety_admin') at kyc.ts:363)
```

**Failing — unguarded mutation** (rule 5, divergence 4):

```
FAIL rule=rule5 route=PUT /surety-license/:id/review method=PUT
  no recognised authorization primitive on PUT /surety-license/:id/review
  (routes/surety-license.ts:137)
  This route mutates surety_license_verifications and is not in ROLE_PERMISSIONS.
```

**Passing.** `main`, with the six divergences baselined:

```
check-role-permissions: 231 routes, 45 matrix entries, 6 baselined divergences

0 errors, 6 baselined errors matched, 231 routes checked
ok — no unbaselined divergence
```

The `6 baselined errors matched` line matters: it proves the baseline still
applies. If someone deletes the route that caused a baselined divergence, the
entry stops matching and the check reports a stale baseline — which is how the
list drains instead of becoming permanent.

### 2.3 Registering permissions for new routes

In `CONTRIBUTING.md`, under a "Adding a route" heading:

1. Declare enforcement with a **recognised primitive** — prefer
   `requireRole('surety_admin')` as middleware over an inline check. Inline
   checks are detectable but not greppable, and they are the reason §1.3b
   exists. New inline role checks should be a review comment.
2. For importer-scoped routes, call `loadImporterFor(req, id)` and treat `null`
   as a 404/403 — do not hand-roll an ownership comparison. Ownership logic in
   58 places is the reason §1.3c exists.
3. Add the entry to `ROLE_PERMISSIONS` in the same PR, in the
   `<METHOD> <path> (<qualifier>)` form. Qualifiers: `(own)`, `(all)`,
   `(grant-scoped)`, `(license-verified)`.
4. If the route is intentionally unguarded, write `// authz: public` above the
   registration. A deliberate exemption should be visible in the diff, not
   inferred from absence.

Steps 1 and 3 are what `rule1`/`rule5` enforce; step 2 is guidance, because
`loadImporterFor` is a shared helper and the check cannot verify that a handler
used it rather than reimplementing it.

### 2.4 Correct the doc comment first

`auth.ts:9-13` should stop claiming authority it does not have. Something like:

```
// SOC 2 CC6.3 — Formal RBAC access matrix.
// This constant is the auditor-facing summary of the access model. It is NOT
// read by any runtime code path; enforcement lives in requireRole(),
// loadImporterFor(), requireLicenseVerified() and inline role checks.
// scripts/check-role-permissions.ts verifies this list against the route table
// in CI — a route without a matching entry here fails the build.
```

That comment is the actual deliverable of the "or CI check" option: the claim
becomes true, because now it is enforced. Keeping the word "authoritative"
while adding the check would be accurate; keeping it without the check is what
makes the current comment a liability.

### 2.5 Land the six existing divergences

Baselining is a staging step, not a destination. Each is small:

| # | Fix |
| --- | --- |
| 1 | Delete `GET /importers/own` from the matrix, or add the route. |
| 2 | Change the matrix to `POST /importers/:id/kyc/:docId/review`. |
| 3 | Mount `erasureRouter` (tracked in RFC 0952 step 1) or drop the two entries. This one is also a live GDPR gap, not just documentation. |
| 4 | Gate `PUT /surety-license/:id/review` — `requireSuretyAdmin` (line 23) matches the intent of `POST /submit` and `GET /status` on the same router. |
| 5 | Gate or document `GET /surety-license`. |
| 6 | Reconcile the `admin` prose with the two `member_role === 'admin'` checks, and decide whether `finance` should have write access (§1.4). |

Divergences 2, 4 and 6 are the ones to land first: 2 misstates a state-changing
endpoint as a read, 4 is an ungated mutation of a compliance record, and 6 is
the one an auditor reading `ROLE_PERMISSIONS.admin` would most likely flag.

## 3. Trade-offs

**For CI verification.**

- It directly addresses the stated risk (drift) with the mechanism the risk
  needs: a build that fails on disagreement.
- It lands green on day one via the baseline, so it can ship without a
  flag-day cleanup of 186 undocumented routes.
- Rules 3, 4 and 5 need **no** knowledge of enforcement mechanisms — only the
  mount table and route regexes. They are also the rules that catch
  divergences 1-5, i.e. five of the six real findings, so most of the value does
  not depend on the fragile parts.
- The baseline is self-draining: a divergence whose route disappears stops
  matching and is reported stale.
- Zero runtime cost. No middleware, no per-request work.

**Against.**

- **Rule 2 is a heuristic.** Matching `user.role !== '…'` textually will miss
  checks written differently, and will not understand a check that is correct
  but structured unusually. The mitigation is the `UNDECLARED` vs `UNGUARDED`
  distinction in §2.1 rule 2 — the check reports what it cannot see instead of
  asserting a violation. But it is a parser over TypeScript source, and parsers
  over source rot when the source is refactored for unrelated reasons. A
  `ts-morph`-based read of the AST would be more robust than regex; that is
  added cost, and regex-first is the pragmatic starting point.
- **Mechanism (c) stays unverifiable.** `loadImporterFor` decides access for 58
  routes using a SQL query and four branches. No static check can confirm a
  handler used it correctly, so importer routes are verified only in the
  "documented or not" direction, never "gated or not". This is a real limit and
  the RFC should not pretend otherwise — the mitigation is the §2.3 step-2
  convention, which is exactly the human discipline the issue is trying to
  reduce.
- Regex-based CI checks get disabled when they produce false positives. The
  baseline is the safety net, but a rule that cries wolf enough times will be
  turned off. Rules 1-2 are the noisy ones; a reasonable alternative is to ship
  rules 3, 4 and 5 as errors and rules 1-2 as warnings for one release, then
  promote.
- Rule 6 requires reformatting all 45 matrix entries, which will produce a
  large, low-information diff in a security-sensitive file. It is unavoidable
  work for machine-readability, and it should be its own PR so review is not
  confused with the behavioural fixes in §2.5.
- The check can only verify what is *declared*. It cannot tell you whether the
  declaration is the *right* permission — only that code and doc agree. An
  auditor still has to read the matrix. That is inherent to verification and is
  why §2.4 keeps the matrix as the auditor-facing artifact.

**Rejected: generate the matrix from route metadata.** Discussed in §2. Requires
declarative permission metadata on all 231 routes across 27 files, including a
declarative re-expression of `loadImporterFor`'s four-axis logic, and the first
output would be a guess about 186 undocumented routes presented to auditors as
authoritative. Highest ceiling, highest risk, and it does not actually reduce the
work — it relocates it into every route file, permanently.

**Rejected: delete `ROLE_PERMISSIONS` and rely on the SOC 2 doc.** Tempting,
because it removes the drift risk by removing the artifact. But
`docs/security/soc2-cc6-controls.md:58` points auditors at it, an access matrix
is a normal audit deliverable, and deleting it makes "show me the access model"
harder to answer than "show me the access model, and here is the build check
that keeps it true". Documentation that is verified beats no documentation.

**Rejected: status quo plus a comment.** The comment already says "keep it in
sync". It has not worked, and the six divergences in §1.5 are the evidence.

## 4. Open questions

1. Should the baseline be a committed JSON file, or should pre-existing
   divergences be fixed **before** the check lands so no baseline is needed? The
   second is cleaner but couples this RFC to five fixes (§2.5), one of which
   (#3, `erasureRouter`) is owned by RFC 0952. The baseline lets the two land
   independently.
2. Regex or `ts-morph` for rules 1-2 from day one? Regex is faster to ship and
   adequate for the current uniform style of `requireRole`; `ts-morph` survives
   refactors. Worth a decision before writing the parser.
3. Should the check also assert the *absence* of over-permission — a documented
   entry whose route is gated by a *different* role than documented? That is the
   check that would catch a route upgraded to `surety_admin` without updating the
   matrix. Rules 1-2 as specified verify each side independently; a cross-check
   that the two agree on the same route needs a merged model.
4. Should the `finance` team-member role (§1.4) be given an explicit rule in
   `loadImporterFor` before or after the check lands? It is a possible
   over-permission today, and rule 5 cannot see it because those routes *are*
   guarded — just guarded permissively.
