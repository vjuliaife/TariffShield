# Tariff Calculation Methodology

This document explains how TariffShield converts an importer's tariff CSV upload into a
`required_collateral` value that is stored on the Soroban contract.

---

## Overview

Collateral calculation is a two-step process:

1. **The importer uploads a tariff CSV** via `POST /importers/:id/upload-tariff-csv`. The
   API parses each line item, validates duty rates against the CBP schedule, and computes
   `annual_duty` — the total estimated duties the importer will owe in a year.

2. **The platform derives `required_collateral`** from `annual_duty` using the formula
   below, then calls `set_required_collateral` on the Soroban contract so the collateral
   requirement is enforced on-chain.

---

## Formula

```
required_collateral = annual_duty × 10% × 50%
```

| Factor | Value | Source |
|--------|-------|--------|
| `annual_duty` | Sum of `import_value × duty_rate` across all HTS line items | Computed from the CSV upload |
| 10% | CBP continuous bond rate (bond face value ≈ 10 % of annual duties) | [CBP Publication No. 0000-0863](https://www.cbp.gov/sites/default/files/assets/documents/2016-Apr/bond_directive.pdf) |
| 50% | TariffShield over-collateralization buffer (industry-typical cash demand for new importers) | TariffShield underwriting policy |

In code (`apps/api/src/routes/importers.ts`, lines 271–274):

```typescript
// CBP rule of thumb: continuous bond face value ~= 10% of annual duties+taxes+fees.
// We require importer to collateralize 50% of bond face value.
const bondFaceValue        = annualDutyTotal * 0.1;
const requiredCollateralUSD = bondFaceValue  * 0.5;
```

The USD amount is then converted to stroops (7 decimal places) before being sent on-chain:

```typescript
const requiredStroops = BigInt(Math.round(requiredCollateralUSD * 1e7));
```

---

## CSV Format Specification

The API accepts a JSON body (the CSV is parsed client-side before upload), but the logical
structure mirrors a CSV with the following columns:

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `htsCode` | `string` | Yes | Harmonized Tariff Schedule code (e.g. `"8471.30.01"`) |
| `value` | `number` | Yes | Estimated annual import value in USD. Must be positive. |
| `dutyRate` | `number` | Yes | Applicable duty rate as a decimal fraction (e.g. `0.075` for 7.5 %). Must be between 0 and 1. |
| `filename` | `string` | No | Original filename stored for audit purposes only. |

**Validation rules:**

- `value` must be a positive number (zero-duty lines are allowed; they contribute `$0` to `annual_duty`).
- `dutyRate` must be `>= 0`. A rate of `0` is valid (duty-free goods).
- Each `htsCode` is looked up against the live CBP duty schedule. If the reported rate
  deviates from the CBP rate by more than 10 %, the upload is flagged. In strict mode
  (`CBP_VALIDATION_MODE != "warn"`) it is rejected with HTTP 422.

---

## Worked Example

Suppose an importer uploads the following three HTS codes:

| HTS Code | Annual Import Value | Duty Rate | Line Duty |
|----------|-------------------|-----------|-----------|
| 8471.30.01 | $500,000 | 0.00 (duty-free) | $0 |
| 6110.20.20 | $200,000 | 0.12 (12 %) | $24,000 |
| 8708.99.68 | $150,000 | 0.025 (2.5 %) | $3,750 |

**Step 1 — compute `annual_duty`:**

```
annual_duty = (500,000 × 0.00) + (200,000 × 0.12) + (150,000 × 0.025)
            = 0 + 24,000 + 3,750
            = $27,750
```

**Step 2 — apply the formula:**

```
bond_face_value      = 27,750 × 10%  = $2,775
required_collateral  = 2,775  × 50%  = $1,387.50
```

The contract receives `1,387.50 × 10^7 = 13,875,000,000` stroops as `required_collateral`.

---

## Code References

| File | What it does |
|------|-------------|
| `apps/api/src/routes/importers.ts` — `POST /:id/upload-tariff-csv` | Parses the CSV, computes `annualDutyTotal`, applies the formula, calls `set_required_collateral` |
| `contracts/tariff-shield/src/lib.rs` — `set_required_collateral` | Stores `required_collateral` on-chain; applies USDC/USD oracle adjustment and enforces the 5× cap guard |

---

## Edge Cases

**Zero-duty HTS codes**
Lines with `dutyRate: 0` contribute `$0` to `annual_duty`. Including them is valid and
reflects duty-free goods; they do not inflate the collateral requirement.

**Currency**
All values are assumed to be in USD. The demo environment uses a 1 USD ≈ 1 XLM stand-in.
In production the on-chain oracle adjusts `required_collateral` for the live USDC/USD rate
(see `set_required_collateral` in `lib.rs`).

**Minimum collateral floor**
CBP requires a minimum continuous bond of $50,000. If the computed `required_collateral`
falls below this threshold, the surety admin should override it at registration time by
passing the $50,000 minimum to `register_importer`.

---

## Recalculation Policy

`required_collateral` is recalculated whenever:

- The importer uploads a new tariff CSV (`POST /importers/:id/upload-tariff-csv`).
- An annual review triggers a manual recalculation by the oracle admin.

The contract enforces a **24-hour rate-limit** on `set_required_collateral` — consecutive
uploads within the same calendar day are rejected until the cooldown expires.

When a recalculation produces a higher `required_collateral` than the importer's current
`collateral_balance`, the **auto top-up** mechanism (`auto_top_up`) draws from the
importer's `reserve_balance` to close the gap automatically, without requiring a manual
deposit.
