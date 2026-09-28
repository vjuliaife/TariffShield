# API Authentication

This document describes how to authenticate with the TariffShield REST API: header format, token acquisition, and which routes require a bearer token versus an API key versus no credential at all.

---

## Bearer token format

Every protected route expects a JSON Web Token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is a signed JWT issued by the TariffShield auth service. It encodes the caller's user ID and role, and expires after a short window (typically 15 minutes). See [Token acquisition](#token-acquisition) for how to obtain one.

### API key alternative

Machine-to-machine integrations may use a long-lived API key instead of a session JWT. Pass it in the same `Authorization` header **and** in `X-Api-Key`:

```
Authorization: Bearer <api-key>
X-Api-Key: <api-key>
```

API keys are created via `POST /api-keys` once authenticated with a session token. They do not expire automatically but can be revoked.

---

## Token acquisition

### 1. Email/password login

```http
POST /auth/login
Content-Type: application/json

{
  "email": "importer@example.com",
  "password": "your-password"
}
```

**Response** (200):

```json
{
  "token": "<access-jwt>",
  "refreshToken": "<refresh-token>"
}
```

Store the `token` in memory and the `refreshToken` in secure, HTTP-only storage. Do **not** persist the access token across sessions.

### 2. Token refresh

Access tokens are short-lived. Refresh before expiry:

```http
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "<refresh-token>"
}
```

**Response** (200):

```json
{
  "token": "<new-access-jwt>",
  "refreshToken": "<new-refresh-token>"
}
```

Refresh tokens are rotated on every use. Discard the old pair immediately.

### 3. SAML SSO (enterprise)

Enterprise accounts can authenticate via SAML 2.0. Redirect the browser to:

```
GET /auth/saml/<provider>/login
```

After the IdP callback the API issues the same JWT pair as above.

---

## Route protection table

| Route prefix | Auth required | Role required |
|---|---|---|
| `POST /auth/login` | None | — |
| `POST /auth/refresh` | None | — |
| `GET /auth/saml/*` | None | — |
| `POST /auth/signup` | None | — |
| `GET /hts-lookup/*` | Bearer token | any |
| `GET /importers/*` | Bearer token | any |
| `POST /importers/*` | Bearer token | `admin` |
| `GET /broker/*` | Bearer token | `broker` or `admin` |
| `POST /surety-marketplace/*` | Bearer token | any |
| `DELETE /surety-marketplace/admin/*` | Bearer token | `admin` |
| `POST /erasure/*` | Bearer token | any |
| `GET /notifications/*` | Bearer token | any |
| `GET /developer/*` | Bearer token | any |
| `GET /privacy/*` | Bearer token | any |
| `POST /api-keys` | Bearer token | any |

> **Note:** Routes listed as "any" still require a valid, non-expired JWT. They do not require a specific role beyond being an authenticated user.

---

## Common errors

| Status | Body | Cause |
|---|---|---|
| 401 | `{"error": "missing or invalid token"}` | `Authorization` header absent or malformed |
| 401 | `{"error": "token expired"}` | JWT past its `exp` claim — refresh and retry |
| 401 | `{"error": "invalid or expired refresh token"}` | Refresh token already rotated or expired |
| 403 | `{"error": "forbidden"}` | Valid token but insufficient role for this route |

---

## Related docs

- [API Error Codes](./error-codes.md)
- [Postman Guide](./postman-guide.md)
- [SDK Network Configuration](../guides/sdk-network-config.md)
