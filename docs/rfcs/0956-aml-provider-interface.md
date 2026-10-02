# RFC 0956: Extract an `AmlProvider` interface before the mock is replaced by a vendor

- Status: Proposed
- Issue: #956

## Summary

`services/aml-screening.ts` exports `screenWalletAddress()`, which contains the
mock scoring, the `aml_screenings` audit insert and the resolution-action
policy in one function. Introduce a narrow `AmlProvider` interface that owns
only the vendor call, keep the audit insert and resolution policy in a thin
`AmlScreeningService` that all callers keep using, and select the provider via
`env.ts`. A real vendor then becomes one new class plus config, with no
call-site changes.

## 1. Current state

### Call sites (`apps/api/src/routes/importers.ts`)

| Line | Route purpose | Address screened | Consumes |
| --- | --- | --- | --- |
| 97 | importer registration | `kp.publicKey()`, a **freshly generated** keypair | `riskScore === 'HIGH'` |
| 1553 | `POST /:id/deposit` | `importer.stellar_address` | `riskScore === 'HIGH'` |
| 1856 | `POST /:id/deposit-schedule` | `importer.stellar_address` | `riskScore === 'HIGH'` |
| 2275 | `POST /:id/withdrawal-requests/:requestId/approve` (dual-approval withdraw) | `importer.stellar_address` | `riskScore === 'HIGH'` |
| 2448 | `POST /:id/withdraw` | `importer.stellar_address` | `riskScore === 'HIGH'` |
| 2568 | `POST /:id/scheduled-withdrawals` | `importer.stellar_address` | `riskScore === 'HIGH'` |

`screenImporterEntity()` (OFAC name/EIN check, line 83) lives in the same file
and is also a mock (`legalName.includes('sanctioned')`); it is a separate
concern (entity sanctions, not wallet risk) but has the same coupling problem.

### Coupling to the mock's shape

- **All six call sites read exactly one field, `riskScore`, and compare it to
  the literal `'HIGH'`.** No caller reads `providerResponse` or
  `resolutionAction`. So the return *shape* is not what couples callers to
  the mock; the coupling is (a) the direct import of a concrete function and
  (b) the policy "HIGH means 403, everything else proceeds" repeated inline
  six times.
- The function has three responsibilities: call a provider (mock),
  derive `resolutionAction` from the score, and `INSERT INTO aml_screenings`.
  A vendor swap would touch the first only, but today all three are in one
  body, so a rewrite risks the audit insert.
- The audit row is written **inside** the screening call, before the caller
  decides anything, and on **every** call. A real vendor charges per
  screening and adds network latency, and it is called on the request path
  for every deposit and withdrawal.
- The route at line 97 screens an address that was generated one line earlier
  and has no chain history. That call is meaningless against a real vendor
  (there is nothing to score). The design must decide what registration
  screening means (see section 5).

### Audit fields relied on by compliance reporting

- `aml_screenings` columns: `wallet_address`, `screening_timestamp`,
  `risk_score`, `provider_response JSONB`, `resolution_action`.
- `jobs/compliance-report.ts` reads only
  `COUNT(*) FROM aml_screenings WHERE screening_timestamp BETWEEN ...`
  (`amlScreening.screened`). `sarEligibleEvents` is hard-coded `0` with the
  comment "populated by AML provider integration".
- `jobs/retention-enforcement.ts` deletes `aml_screenings` rows after the
  retention period unless a legal hold exists (`record_table = 'aml_screenings'`).
- `providerResponse` is currently `{ mockProvider, score, screenedAt }`;
  `resolutionAction` is one of `pending_manual_review`, `auto_cleared_medium`,
  `auto_cleared_low`.
- `compliance_flags.flag_type` allows `'aml_high_risk'`, but **nothing in
  `apps/api/src` inserts that flag**, so a HIGH result currently produces a
  `pending_manual_review` row that no queue or job consumes. There are also
  no tests that reference AML screening.

## 2. Proposed interface

```ts
// services/aml/provider.ts
export type AmlRiskScore = 'LOW' | 'MEDIUM' | 'HIGH';

export interface AmlProviderResult {
  riskScore: AmlRiskScore;            // provider's verdict, normalized
  providerResponse: Record<string, unknown>; // raw/verbatim, stored as-is
}

export interface AmlProvider {
  readonly name: string;              // 'mock', 'chainalysis-kyt', ...
  readonly version: string;           // adapter version, for the audit trail
  screenWallet(address: string, ctx?: { signal?: AbortSignal }): Promise<AmlProviderResult>;
}
```

The provider does the vendor call and score normalization and **nothing
else**: it never touches the database and never decides `resolutionAction`.

```ts
// services/aml-screening.ts  (same public function as today)
export async function screenWalletAddress(address: string): Promise<AmlScreeningResult> {
  const p = getAmlProvider();                       // from config, memoized
  const { riskScore, providerResponse } = await p.screenWallet(address);
  const resolutionAction = resolutionFor(riskScore); // pure, unit-testable
  await recordScreening({ address, riskScore,
    providerResponse: { provider: p.name, adapterVersion: p.version, ...providerResponse },
    resolutionAction });
  return { walletAddress: address, riskScore, providerResponse, resolutionAction };
}
```

Consequences:

- **Zero call-site changes.** The six routes keep importing
  `screenWalletAddress` and reading `riskScore`. The public type
  `AmlScreeningResult` is unchanged.
- **`MockAmlProvider`** is the existing `determineMockRiskScore` logic moved
  verbatim into `services/aml/mock-provider.ts`, returning
  `{ mockProvider: 'ChainalysisMock', score, screenedAt }` as its
  `providerResponse`, so existing rows and new mock rows are indistinguishable
  in shape.
- **Audit fields are preserved.** `provider_response` gains `provider` and
  `adapterVersion` keys *added alongside* the existing keys (additive JSONB, no
  column or migration change); `resolution_action` values and the
  `aml_screenings` insert are unchanged. `resolutionFor()` is the single place
  the score-to-action policy lives, replacing the inline if/else.
- The repeated `riskScore === 'HIGH'` gate can follow later as
  `assertNotBlocked(res)`; it is not required for the swap and is left out to
  keep this change reviewable.

## 3. Provider selection (`config/env.ts`)

```ts
AML_PROVIDER: z.enum(['mock', 'chainalysis', 'elliptic', 'trm']).default('mock')
  .describe('AML wallet-screening provider. Non-mock values require the matching *_API_KEY.'),
AML_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
AML_FAIL_MODE: z.enum(['closed', 'open']).default('closed'),
// per-vendor secrets are optional and validated conditionally:
CHAINALYSIS_API_KEY: z.string().optional(),
```

- A zod `superRefine` on `Env` fails startup if `AML_PROVIDER !== 'mock'` and
  its key is missing, and if `NODE_ENV === 'production'` and
  `AML_PROVIDER === 'mock'` (the mock must not silently run in production).
  Whether to hard-fail or warn on that last case is the main open question.
- `getAmlProvider()` is a small registry keyed by the enum; adding a vendor is
  one new file plus one registry entry plus one enum value.
- Document the new variables in `docs/environment-variables.md`.

## 4. Behaviors the interface must pin down before a vendor lands

These are the things a swap would otherwise decide implicitly, under deadline:

1. **Outage policy.** With a real vendor, `screenWallet` can time out or
   error. Today's mock cannot. `AML_FAIL_MODE=closed` (default) turns a provider
   error into a 503 "screening unavailable" for money-moving routes;
   `open` proceeds and records `resolution_action = 'provider_unavailable'`
   for later re-screening. This is a compliance decision, not an engineering one.
2. **Timeout/cancellation** via `AbortSignal` and `AML_PROVIDER_TIMEOUT_MS`.
3. **Result caching.** Screening on every deposit/withdraw is per-call vendor
   cost. A short TTL cache keyed by address (with the audit row still written
   per decision) is the likely mitigation; the interface allows it to be a
   decorator around any provider.
4. **Registration screening.** Screening a just-generated address (route at
   line 97) should be replaced by screening the *source of funds* at first
   deposit, or dropped for registration; with a real vendor it always
   returns LOW.
5. **A consumer for `pending_manual_review`.** Insert an `aml_high_risk`
   `compliance_flags` row on HIGH and populate `sarEligibleEvents` in
   `compliance-report.ts`. Independent of the interface but needed for the
   audit story to hold with a real provider.

## 5. Trade-offs

**Introduce the interface now**

- (+) The vendor swap is config plus one class; routes and reporting do not
  change, so it is safe under compliance-deadline pressure.
- (+) Separating provider, policy (`resolutionFor`) and persistence makes the
  policy and the audit write testable in isolation. There are currently no AML
  tests at all.
- (+) Forces the outage, timeout and cache questions to be answered
  deliberately instead of during vendor integration.
- (-) One extra abstraction for a single implementation today: about 4 small
  files and a registry. Kept small on purpose (one method, no generics).
- (-) Risk of designing the interface around the mock rather than a real
  vendor. Mitigated by keeping `providerResponse` opaque (raw JSON is stored
  as-is) and normalizing only the three-level score every caller already uses.
  Real vendors expose richer data (exposure categories, alert ids); the opaque
  blob preserves it without an interface change.

**Wait for the real integration**

- (+) No speculative abstraction; the interface would be shaped by the real
  vendor's API.
- (-) The refactor then lands in the same PR as the compliance-critical
  integration, in a file mixing audit persistence with policy, exactly when
  regression risk is least acceptable.

**Recommendation:** introduce it now, limited to the shape above (one method, the
service keeps persistence and policy). It is mostly a move of existing code,
with no schema or route changes.

## 6. Rollout

1. Add `services/aml/{provider,mock-provider,registry}.ts`; move the mock; keep
   `screenWalletAddress`/`AmlScreeningResult` signatures. Add unit tests for
   `resolutionFor`, the mock, and that the audit row keeps its old keys.
2. Add `AML_PROVIDER` (default `mock`) to `env.ts` and the env docs.
3. Follow-ups (separate PRs): fail-mode/timeout, `aml_high_risk` flag +
   `sarEligibleEvents`, `screenImporterEntity` behind the same pattern
   (`SanctionsProvider`).
