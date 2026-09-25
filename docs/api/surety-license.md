# Surety License API

Insurance license verification for `surety_admin` accounts (#324).
Implementation: [`apps/api/src/routes/surety-license.ts`](../../apps/api/src/routes/surety-license.ts).

The flow has three steps:

1. A `surety_admin` signs up — a `pending` verification record is created
   automatically (see `apps/api/src/routes/auth.ts`).
2. The surety admin submits their NAIC number and company details —
   `POST /surety-license/submit` (see [Submit](#post-surety-licensesubmit)).
3. A platform admin reviews and approves or rejects the submission via
   `PUT /surety-license/:id/review` (not documented here — this doc covers
   only the two endpoints from #324's acceptance criteria).

Until step 3 results in `status: "verified"`, `requireLicenseVerified()`
blocks license-gated operations (e.g. `accrue-yield`, `clawback`) for that
`surety_admin` with a `403`.

## Authentication

Both endpoints require a `surety_admin`-role session:

```
Authorization: Bearer <jwt>
```

A request from any other role receives `403 { "error": "surety_admin only" }`.

## `POST /surety-license/submit`

Submits (or re-submits) NAIC number and company details for review. Sets
`status` to `submitted`.

- **Method:** `POST`
- **Path:** `/surety-license/submit`
- **Auth:** `surety_admin`

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `naicNumber` | string | Yes | 1–20 characters. |
| `companyName` | string | Yes | 1–255 characters. |
| `stateOfDomicile` | string | Yes | Exactly 2 characters; upper-cased automatically (`"ca"` → `"CA"`). |
| `amBestRating` | string | No | Up to 10 characters, e.g. `"A+"`. |
| `licenseStatusDetail` | string | No | Free-text, up to 1000 characters. |

### Example request

```bash
curl -X POST "$API_URL/surety-license/submit" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "naicNumber": "12345",
    "companyName": "Acme Surety Co.",
    "stateOfDomicile": "ca",
    "amBestRating": "A+",
    "licenseStatusDetail": "Admitted carrier in all 50 states"
  }'
```

### Responses

| Status | Body | When |
|---|---|---|
| `200 OK` | `{ "message": "...", "id": "<uuid>", "status": "submitted" }` | Details saved and marked `submitted`. |
| `400 Bad Request` | `{ "error": "invalid input", "target": "body", "details": [...] }` | Body fails schema validation (see [error-codes.md](./error-codes.md)). |
| `403 Forbidden` | `{ "error": "surety_admin only" }` | Caller isn't a `surety_admin`. |
| `404 Not Found` | `{ "error": "no license verification record found for this account" }` | No verification row exists for this user (shouldn't normally happen — the row is created at signup). |

```json
{
  "message": "License details submitted for review. A platform admin will verify your NAIC credentials.",
  "id": "8f14e45f-ceea-4c19-8b5d-4c2c9f3d2b1a",
  "status": "submitted"
}
```
