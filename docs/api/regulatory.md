# Regulatory API

## Endpoints

### Get State Regulatory Report

Generates a compliance report for a single state, covering bonds
written, claims filed, on-chain collateral held, and importer
segmentation over a reporting period. Restricted to sureties with an
active license record for the requested state.

- **URL:** `/api/v1/regulatory/state-report/:state_code`
- **Method:** `GET`
- **Authentication Required:** Yes (must re-accept privacy and TOS)
- **Role Required:** `surety_admin`

#### Path Parameters

- `state_code` (string): The state to report on. Sent as-is, uppercased
  server-side before use, so lowercase input works too. There's no fixed
  enum of accepted values — conventionally a 2-letter USPS state
  abbreviation (e.g. `CA`, `NY`, `TX`), matching whatever was recorded
  when the surety's state license was set up. In practice the only
  values that will ever succeed are states the caller holds an active
  license for; anything else fails with `403` (see below), which is the
  endpoint's real validation.

#### Query Parameters

All are optional.

| Name         | Type                              | Default                | Description                                  |
| ------------ | --------------------------------- | ----------------------- | --------------------------------------------- |
| `start_date` | ISO 8601 datetime or `YYYY-MM-DD` | 30 days before `now`    | Start of the reporting period (inclusive).    |
| `end_date`   | ISO 8601 datetime or `YYYY-MM-DD` | `now`                   | End of the reporting period (inclusive).      |
| `format`     | `"json"` \| `"csv"`               | `"json"`                | Response format.                              |

`start_date` must not be after `end_date`, or the request is rejected
with `400`.

#### Response (200 OK, `format=json`)

```json
{
  "stateCode": "CA",
  "reportingPeriod": {
    "startDate": "2026-08-26T00:00:00.000Z",
    "endDate": "2026-09-25T00:00:00.000Z"
  },
  "stats": {
    "totalBondsWritten": 42,
    "aggregateFaceValue": "1250000",
    "claimsFiled": 3,
    "collateralHeldOnChain": "980000",
    "totalImporterCount": 37
  },
  "importerSegmentation": [
    { "businessState": "CA", "count": 30 },
    { "businessState": "NV", "count": 7 }
  ],
  "reportTemplate": {
    "logoUrl": null,
    "headerText": "TariffShield Compliance Report",
    "footerText": null
  }
}
```

`aggregateFaceValue` and `collateralHeldOnChain` are returned as strings
(not numbers) to avoid floating-point precision loss on large monetary
totals. `importerSegmentation` groups importers by their registered
business state (`"UNKNOWN"` when unset); its counts sum to
`stats.totalImporterCount`. `reportTemplate` is the surety's configured
branding (logo/header/footer text), always fetched fresh — see
"Caching" below.

#### Response (200 OK, `format=csv`)

Returns `Content-Type: text/csv` with
`Content-Disposition: attachment; filename="regulatory_report_<STATE_CODE>.csv"`.
One row per `importerSegmentation` entry (or a single all-zero-segment
row if there are none), plus `#`-prefixed header/footer comment lines
from the report template when configured. The `#` prefix is
intentional — automated CSV ingestion that skips comment lines gets a
clean data table; a human opening the file directly sees the branding.

#### Response (403 Forbidden — no active license for the state)

```json
{
  "error": "Access Denied",
  "message": "A active surety license record is required for state 'CA' to generate this report."
}
```

Also returned as a plain `{ "error": "forbidden" }` if the caller isn't
a `surety_admin` at all.

#### Response (400 Bad Request)

```json
{
  "error": "invalid query parameters",
  "details": [ /* zod issue objects */ ]
}
```

or, when `start_date` is after `end_date`:

```json
{ "error": "start_date must be before or equal to end_date" }
```

#### Caching

Reports are cached in-memory per `(state_code, caller, start_date,
end_date, format)` combination for 24 hours. A cache hit/miss is
reported via the `X-Cache` response header (`HIT` or `MISS`) and never
affects the response body's `reportTemplate` — that's re-fetched on
every request regardless of cache state, so an edit to the surety's
report branding shows up immediately even while the underlying report
data is still served from cache.

#### Example Request

```bash
curl "https://api.example.com/api/v1/regulatory/state-report/CA?start_date=2026-01-01&end_date=2026-06-30" \
  -H "Authorization: Bearer <token>"
```
