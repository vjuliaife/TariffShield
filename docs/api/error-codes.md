# API Error Codes Reference

This document enumerates every HTTP error response the TariffShield API can produce, including status codes, response shapes, and the conditions that trigger each error.

## Response Envelope

All error responses follow one of two shapes:

**Standard error:**
```json
{
  "error": "Human-readable message"
}
```

**Validation error (400 / 422):** includes a `details` array with Zod issue objects:
```json
{
  "error": "invalid input",
  "details": [
    {
      "code": "too_small",
      "minimum": 8,
      "type": "string",
      "inclusive": true,
      "exact": false,
      "message": "String must contain at least 8 character(s)",
      "path": ["password"]
    }
  ]
}
```

The `details` array is **only present on 400 and 422 responses** that originate from schema validation. Other error responses contain only `"error"`.

---

## HTTP Status Codes

| Status | Name | When It Occurs |
|--------|------|----------------|
| 400 | Bad Request | Request body fails schema validation (missing required fields, wrong types, regex mismatch) |
| 401 | Unauthorized | Missing or invalid Bearer token; invalid credentials on login; SAML assertion missing NameID |
| 403 | Forbidden | Authenticated user lacks the required role; account is locked; KYC not approved; AML flag; OFAC hit; privacy policy re-acceptance required; surety license not verified |
| 404 | Not Found | Resource does not exist or the authenticated user does not own it; unknown SAML provider |
| 409 | Conflict | Unique constraint violation — email already registered; importer already registered for user |
| 422 | Unprocessable Entity | Business rule violation — bond validation failed; CBP duty rate deviation exceeds 10% |
| 429 | Too Many Requests | Brute-force lockout (10 failed login attempts in 30 min); Soroban on-chain rate limit (collateral update once per 24 h) |
| 500 | Internal Server Error | Unhandled exception; Stellar transaction failed or timed out; unexpected database error |
| 501 | Not Implemented | SAML SSO requested for a provider whose environment variables are not configured |
| 503 | Service Unavailable | Database connection pool exhausted or Soroban RPC unreachable (surfaces as unhandled exception in current implementation) |

---

## Error Messages by Route Group

### Authentication — `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` | Request body fails `SignupSchema` or `LoginSchema` validation |
| 401 | `"invalid credentials"` | Email not found or password does not match |
| 401 | `"missing bearer token"` | `Authorization: Bearer <token>` header absent on a protected route |
| 401 | `"invalid token"` | JWT is expired, malformed, or signed with the wrong secret |
| 403 | `"account temporarily locked, try again later"` | `locked_until` is set on the user record and has not yet elapsed |
| 403 | `"privacy policy update requires re-acceptance"` | `privacy_reacceptance_required = TRUE` on the user record; also includes `"reason": "privacy_policy_update"` and `"action": "POST /account/accept-privacy-policy"` |
| 409 | `"email already registered"` | PostgreSQL unique violation on `users.email` |
| 429 | `"too many failed attempts, account locked for 30 minutes"` | ≥ 10 failed login attempts in the last 30 minutes for that email |

#### SAML SSO — `GET /auth/saml/:provider/login`, `POST /auth/saml/:provider/callback`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"missing SAMLResponse"` | `POST /callback` body does not contain a `SAMLResponse` field |
| 400 | `"malformed SAMLResponse"` | Base64 decoding of the SAML response fails |
| 401 | `"SAML assertion missing NameID"` | Decoded XML does not contain a `<NameID>` element |
| 404 | `"unknown SAML provider"` | `:provider` is not `okta` or `azure` |
| 501 | `"SAML SSO for '<provider>' is not configured on this instance"` | SAML environment variables (`SAML_<PROVIDER>_ENTRY_POINT`, `SAML_<PROVIDER>_CERT`) are not set |

---

### Importers — `apps/api/src/routes/importers.ts`

#### Registration — `POST /importers`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` (+ `details`) | Body fails `CreateImporterSchema` validation |
| 403 | `"only importer accounts can register"` | Authenticated user has `role = "surety_admin"` |
| 403 | `"Importer failed OFAC sanctions screening"` | Entity name / EIN matched the OFAC sanctions list |
| 403 | `"Wallet address flagged as high risk by AML provider"` | Newly generated Stellar address returned `riskScore = "HIGH"` from AML screening |
| 409 | `"importer already registered for this user"` | A row already exists in `importers` for this `user_id` |
| 422 | `"Bond validation failed"` (+ `details`) | CBP Form 301 bond validation failed (invalid bond type, EIN format, principal name) |

#### Account operations — `GET /importers/:id`, `GET /importers/:id/collateral-status`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 404 | `"not found"` | No importer row with that ID, or importer is owned by a different user |

#### Tariff CSV upload — `POST /importers/:id/upload-tariff-csv`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` (+ `details`) | Body fails `TariffUploadSchema` validation |
| 404 | `"not found"` | Importer not found or not owned by caller |
| 422 | `"CBP validation failed"` (+ `report`) | One or more HTS code duty rates deviate > 10% from CBP lookup and `CBP_VALIDATION_MODE=block` |
| 429 | `"rate limit exceeded"` | Soroban contract error `Error(Contract, #13)` — `set_required_collateral` called more than once within 24 hours. Response also includes `retryAfter` (Unix timestamp) and `Retry-After` header |

#### Collateral deposit — `POST /importers/:id/deposit`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` | Body fails `DepositSchema` validation |
| 403 | `"KYC approval required before collateral deposits"` | `importer.kyc_status != "approved"`; response also includes `"kycStatus"` field |
| 403 | `"Transaction blocked pending AML review"` | Wallet address AML re-check returned `riskScore = "HIGH"` |
| 404 | `"not found"` | Importer not found or not owned by caller |

#### Withdrawal — `POST /importers/:id/withdraw`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` | Body fails `WithdrawSchema` |
| 403 | `"Transaction blocked pending AML review"` | Wallet AML re-check returned `riskScore = "HIGH"` |
| 404 | `"not found"` | Importer not found or not owned by caller |

#### Surety admin operations — `POST /importers/:id/accrue-yield`, `POST /importers/:id/clawback`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` | Body fails `YieldSchema` (accrue-yield only) |
| 403 | `"surety admin only"` | Authenticated user is not `surety_admin` |
| 403 | `"surety license not verified"` | Surety license verification status is not `"verified"`; response also includes `"message"` and `"currentStatus"` |
| 404 | `"not found"` | Importer not found |

---

### Admin — `apps/api/src/routes/admin.ts`

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 400 | `"invalid input"` (+ `details`) | Body fails schema on `POST /admin/privacy-policy/publish` |
| 403 | `"surety admin only"` | Caller is not `surety_admin` on `GET /admin/oracle-alerts` or `PATCH /admin/oracle-alerts/:id/acknowledge` |
| 404 | `"alert not found"` | Alert ID does not exist on `PATCH /admin/oracle-alerts/:id/acknowledge` |

---

### Session — `POST /auth/logout`, all protected routes

| HTTP Status | Error Message | Condition |
|-------------|---------------|-----------|
| 401 | `"missing bearer token"` | No Authorization header |
| 401 | `"invalid token"` | Token is expired or malformed |
| 401 | `"re-authentication required"` | JWT does not contain a `sessionId` — token was issued before session management was deployed; client must re-login |
| 401 | `"session expired or not found"` | Session has been revoked (logout) or timed out (15-minute inactivity) |
| 503 | `"session validation unavailable"` | Database is unreachable during session validation; fail-closed by design — the request is blocked until the database recovers |

---

### Other route groups

Error responses on `/compliance/*`, `/kyc/*`, `/bonds/*`, `/surety-license/*`, `/privacy/*`, and `/account/*` follow the same patterns: `400` for validation failures, `403` for role mismatches, `404` for missing resources, and `500` for unhandled errors. Refer to the route source files in `apps/api/src/routes/` for route-specific conditions.

---

## Validation Error Format

When a request body fails Zod schema validation, `details` is an array of issue objects:

```json
{
  "error": "invalid input",
  "details": [
    {
      "code": "invalid_type",
      "expected": "number",
      "received": "string",
      "path": ["bondId"],
      "message": "Expected number, received string"
    },
    {
      "code": "too_small",
      "minimum": 1,
      "type": "string",
      "inclusive": true,
      "exact": false,
      "message": "String must contain at least 1 character(s)",
      "path": ["legalName"]
    }
  ]
}
```

Key issue `code` values: `"invalid_type"`, `"too_small"`, `"too_big"`, `"invalid_string"` (regex), `"invalid_enum_value"`, `"invalid_literal"`.

---

## Stellar-Originated Errors

Soroban contract invocations can fail for contract-level reasons. The SDK (`packages/sdk/src/index.ts`) surfaces these as plain `Error` objects whose `.message` contains the raw Soroban error string.

**Soroban error format in logs:**
```
Error(Contract, #13)
```

The number is the contract error code defined in `contracts/tariff-shield/src/errors.rs`.

**Mapping to API responses:**

| Soroban Error | Contract Meaning | API Response |
|---------------|-----------------|--------------|
| `Error(Contract, #13)` | `RateLimitExceeded` — `set_required_collateral` called within 24 h of last oracle update | `429 { "error": "rate limit exceeded", "retryAfter": <unix_ts> }` |
| All other contract errors | Authorization failures, arithmetic overflows, invalid state | `500` — unhandled, logged server-side |

The full set of contract error codes is defined in `contracts/tariff-shield/src/errors.rs`. Only `#13` is currently mapped to a user-facing 4xx response; all others propagate as 500. The raw Soroban error string is logged at the `error` level in the API process and is not forwarded to the client.

**Transaction submission failures** (Stellar network level):
```
send failed: { "status": "ERROR", "errorResult": ... }
```
These also propagate as 500 and are logged with the full `errorResult` XDR.
