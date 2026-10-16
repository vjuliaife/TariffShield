# Auth API: signup, login, refresh, logout

Reference for the email/password auth routes in `apps/api/src/routes/auth.ts`,
which is mounted at `/auth`. For header formats, API keys and which routes need
a token, see [authentication.md](./authentication.md). For SAML SSO and MFA
setup, see the same file and the route source.

All bodies are JSON (`Content-Type: application/json`). The examples use
`$API=http://localhost:3002` (the API's default `PORT`; adjust to your deployment).

---

## POST /auth/signup

Creates a user, records Terms of Service and privacy-policy acceptance, and
signs the user in.

**Rate limit:** 20 requests per 15 minutes per IP, shared with `/auth/login`.
Over the limit returns `429 {"error": "too many auth attempts; try again in 15 minutes"}`.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `email` | string | yes | Valid email address. Lower-cased before storage. Must not already be registered. |
| `password` | string | yes | At least **8** characters. |
| `role` | `"importer"` \| `"surety_admin"` | no | Defaults to `"importer"`. |
| `accept_tos` | boolean | yes | Must be `true`. The current ToS version is recorded. |
| `privacyPolicyVersionId` | string | no | Privacy policy version being accepted. Defaults to the latest effective version. |
| `referralCode` | string | no | Exactly 12 hex characters (case-insensitive). Only valid for `importer` signups. Must belong to an existing importer other than the new user. |

Side effects:
- `surety_admin` accounts get a **pending** surety-license verification record. Operational surety routes stay blocked until a platform admin verifies the license.
- `importer` accounts are enrolled in the onboarding email sequence. A failure there does not fail signup.

### Response `200`

```json
{
  "token": "<access JWT>",
  "refreshToken": "<128-char hex refresh token>",
  "user": { "id": "4f6c…", "email": "importer@example.com", "role": "importer" }
}
```

### Errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "invalid input", "target": "body", "details": [...]}` | Schema validation failed. `details` holds the Zod issues (path + message). |
| 400 | `{"error": "invalid referral code"}` | Unknown code, or the code was used with `role` other than `importer` |
| 400 | `{"error": "self-referrals are not allowed"}` | Referral code belongs to the same email |
| 409 | `{"error": "email already registered"}` | Email is taken |
| 429 | see rate limit above | Too many auth requests |

### Example

```bash
curl -sS -X POST "$API/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "importer@example.com",
    "password": "correct-horse-battery",
    "role": "importer",
    "accept_tos": true
  }'
```

---

## POST /auth/login

**Rate limit:** shared with signup (20 requests per 15 minutes per IP).

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes | Valid email. Matched case-insensitively. |
| `password` | string | yes | |
| `mfaCode` | string | when MFA is enabled | 6-digit TOTP code (±30 s clock skew accepted) |
| `recoveryCode` | string | when MFA is enabled | Single-use backup code, accepted instead of `mfaCode`. It is consumed on use. |

### Responses

**`200`: signed in**

```json
{
  "token": "<access JWT>",
  "refreshToken": "<128-char hex refresh token>",
  "user": { "id": "4f6c…", "email": "importer@example.com", "role": "importer", "mfaEnabled": false }
}
```

**`200`: MFA challenge.** The password was correct but MFA is enabled and no
code was sent. Repeat the request with `mfaCode` or `recoveryCode`.

```json
{ "mfaRequired": true, "message": "MFA code or backup recovery code required" }
```

### Errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "invalid input", "target": "body"}` | Missing or invalid `email` / `password` |
| 401 | `{"error": "invalid credentials"}` | Unknown email or wrong password. Both return the same body so emails cannot be enumerated. |
| 401 | `{"error": "invalid MFA or recovery code"}` | MFA enabled and the code was wrong |
| 403 | `{"error": "account temporarily locked, try again later"}` | Account has an active `locked_until` |
| 429 | `{"error": "too many failed attempts, account locked for 30 minutes"}` | 10 or more failed logins for this email in the last 30 minutes. A P1 security incident is recorded. |
| 429 | IP rate limit body (see above) | Too many auth requests from this IP |

Every attempt, successful or not, is written to the authentication audit log
with IP and user agent.

### Example

```bash
curl -sS -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email": "importer@example.com", "password": "correct-horse-battery"}'

# With MFA enabled
curl -sS -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email": "importer@example.com", "password": "correct-horse-battery", "mfaCode": "123456"}'
```

---

## Token lifecycle

Signing in creates three things:

| Credential | Format | Lifetime | Stored server-side as |
|---|---|---|---|
| Access token (`token`) | JWT (`id`, `email`, `role`, `sessionId`) | **7 days** (`exp` claim) | — (stateless) |
| Session | Row in `user_sessions`, referenced by `sessionId` | Ends after **15 minutes without an authenticated request**, or on logout / revocation | `user_sessions` |
| Refresh token (`refreshToken`) | 64 random bytes, hex encoded | **30 days**, single use | SHA-256 hash in `refresh_tokens` |

Every protected request checks **both** the JWT signature/expiry **and** that
its session is still active. Each successful request extends the session's
15-minute inactivity window. In practice an idle client is signed out after
15 minutes even though the JWT itself is still valid. When that happens the API
returns `401 {"error": "session expired or not found"}`. Use the refresh token
to get a new access token.

**Concurrent sessions:** at login, if the user already has the maximum number
of active sessions (importer 5, surety_admin 3), the least-recently-used
session is revoked first.

```
 login / signup
      │
      ▼
 token (JWT, 7d) ──► protected request ──► session active?  ── yes ─► 200, inactivity timer reset
      │                                         │
      │                                         no (idle > 15 min, logged out, evicted)
      │                                         ▼
      │                                  401 "session expired or not found"
      │                                         │
      ▼                                         ▼
 refreshToken (30d, single use) ──► POST /auth/refresh ──► new token + new refreshToken
                                          │                 (old refreshToken revoked)
                                          └── revoked / expired / reused ─► 401 → sign in again
```

### POST /auth/refresh

Exchanges a refresh token for a new access token **and** a new refresh token.
This does not need an `Authorization` header.

| Field | Type | Required |
|---|---|---|
| `refreshToken` | string | yes (non-empty) |

**Response `200`**

```json
{ "token": "<new access JWT>", "refreshToken": "<new refresh token>" }
```

Behaviour:
- **Rotation:** the presented refresh token is revoked and a new one is issued with a fresh 30-day expiry. Replace the stored token immediately. Presenting the old one again returns `401`.
- A **new session** is created for the new access token. The previous access token keeps working only until its own session goes idle (15 min) or is revoked.
- The response contains no `user` object. Call `GET /auth/me` if you need it.

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "invalid input", "target": "body"}` | Missing or empty `refreshToken` |
| 401 | `{"error": "invalid or expired refresh token"}` | Unknown, already-rotated, revoked or expired (> 30 days) token |
| 401 | `{"error": "user not found"}` | The token's user no longer exists |

```bash
curl -sS -X POST "$API/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken": "'"$REFRESH_TOKEN"'"}'
```

### POST /auth/logout

Ends the current session. **Requires** `Authorization: Bearer <token>` for an
active session. Rate limited to 60 requests per minute.

| Field | Type | Required | Effect |
|---|---|---|---|
| `refreshToken` | string | no, but recommended | Also revokes this refresh token |

**Response `200`**

```json
{ "message": "logged out" }
```

Behaviour:
- The session in the access token is revoked immediately. Any request with that token then gets `401 {"error": "session expired or not found"}`, even though the JWT has not expired.
- If `refreshToken` is sent it is revoked too, so it can no longer be used with `/auth/refresh`. **If you leave it out, the refresh token stays valid until it expires (30 days).** Always send it on a full sign-out.
- Only the current session is affected. Other devices stay signed in.
- Calling logout with an already-revoked session returns `401` from the auth check.

| Status | Body | Cause |
|---|---|---|
| 401 | `{"error": "missing bearer token"}` | No `Authorization: Bearer` header |
| 401 | `{"error": "invalid token"}` | Bad signature or expired JWT |
| 401 | `{"error": "session expired or not found"}` | Session already idle, logged out or evicted |
| 429 | `{"error": "too many requests; try again shortly"}` | Over 60 requests/min |
| 503 | `{"error": "session validation unavailable"}` | Session store unreachable. The API fails closed. |

```bash
curl -sS -X POST "$API/auth/logout" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken": "'"$REFRESH_TOKEN"'"}'
```

### Client checklist

1. Store `token` in memory and `refreshToken` in secure storage (HTTP-only cookie or OS keychain).
2. On `401 "session expired or not found"` or `401 "invalid token"`, call `/auth/refresh` once, replace **both** tokens, and retry the request.
3. If refresh returns `401`, send the user back to `/auth/login`.
4. On sign-out, call `/auth/logout` with the refresh token, then discard both tokens.
