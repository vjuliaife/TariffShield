# SAML 2.0 SSO

TariffShield supports SAML 2.0 single sign-on for `surety_admin` accounts. Two identity providers are supported: **Okta** and **Azure AD**.

The SAML flow is **SP-initiated**: the user clicks a login link, is redirected to the IdP, authenticates, and is redirected back to TariffShield with a SAML assertion.

---

## Endpoints

### `GET /auth/saml/metadata`

Returns the Service Provider (SP) metadata XML. Provide this to your IdP administrator to configure the SAML trust.

**Response:** `application/xml` — SP metadata document containing the `entityId` and Assertion Consumer Service (ACS) URL.

---

### `GET /auth/saml/:provider/login`

Initiates the SSO handshake by redirecting the browser to the IdP's login page.

**Path parameters:**

| Parameter | Valid values |
|-----------|-------------|
| `provider` | `okta` \| `azure` |

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `relay` | No | URL path to redirect back to after successful authentication (must start with `/`) |

**Responses:**

| Status | Condition |
|--------|-----------|
| 302 | Redirects to the IdP AuthnRequest URL |
| 404 | Unknown provider (not `okta` or `azure`) |
| 501 | SAML not configured for this provider on the server |

---

### `POST /auth/saml/:provider/callback`

Receives the SAML assertion from the IdP after successful authentication. Validates the assertion, creates or updates the user, and issues a JWT.

**Path parameters:**

| Parameter | Valid values |
|-----------|-------------|
| `provider` | `okta` \| `azure` |

**Request body (form-encoded or JSON):**

| Field | Required | Description |
|-------|----------|-------------|
| `SAMLResponse` | Yes | Base64-encoded SAML assertion XML from the IdP |
| `RelayState` | No | Must match the `relay` value sent in the login request (if provided) |

**Responses:**

| Status | Condition |
|--------|-----------|
| 200 | JWT issued. If `Accept: text/html`, redirects to `RelayState` path with `?token=<jwt>`. Otherwise returns JSON. |
| 400 | Missing or malformed `SAMLResponse` |
| 401 | SAML assertion missing `NameID` |
| 404 | Unknown provider |
| 501 | SAML not configured for this provider |

**Success response (API client):**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "admin@example.com",
    "role": "surety_admin"
  }
}
```

---

## SSO Handshake Sequence

```
┌──────────┐         ┌──────────────┐         ┌─────────┐
│  Browser │         │  TariffShield │         │   IdP   │
└────┬─────┘         └──────┬───────┘         └────┬────┘
     │                      │                      │
     │  1. GET /auth/saml/okta/login               │
     │─────────────────────>│                      │
     │                      │                      │
     │  2. 302 Redirect to IdP (SAMLRequest)       │
     │<─────────────────────│                      │
     │                      │                      │
     │  3. User authenticates at IdP               │
     │────────────────────────────────────────────>│
     │                      │                      │
     │  4. POST /auth/saml/okta/callback (SAMLResponse)
     │<────────────────────────────────────────────│
     │                      │                      │
     │  5. JWT issued (redirect with ?token=...)   │
     │─────────────────────>                      │
     │                      │                      │
```

1. **Browser** requests `GET /auth/saml/okta/login` (or `azure`).
2. **TariffShield** builds a SAML AuthnRequest and returns a 302 redirect to the configured IdP entry point.
3. **User** authenticates at the IdP.
4. **IdP** POSTs the `SAMLResponse` back to `POST /auth/saml/okta/callback`.
5. **TariffShield** validates the assertion, upserts the `surety_admin` user, creates a session, and returns a JWT.

---

## IdP Configuration Prerequisites

Before the SAML endpoints will return anything other than `501`, the following environment variables must be set on the server:

| Variable | Provider | Description |
|----------|----------|-------------|
| `SAML_OKTA_ENTRY_POINT` | Okta | IdP SSO URL (e.g., `https://yourorg.okta.com/app/.../sso/saml`) |
| `SAML_OKTA_CERT` | Okta | IdP signing certificate (X.509, PEM format) |
| `SAML_AZURE_ENTRY_POINT` | Azure AD | Identity Provider SSO URL |
| `SAML_AZURE_CERT` | Azure AD | IdP signing certificate (X.509, PEM format) |
| `SAML_SP_ENTITY_ID` | Both | SP entity identifier (defaults to `https://tariffshield.io/saml/metadata`) |
| `SAML_SP_ACS_URL` | Both | Assertion Consumer Service URL (defaults to `https://tariffshield.io/auth/saml/okta/callback`) |

The IdP administrator will also need:
- The **ACS URL** (from `GET /auth/saml/metadata`)
- The **SP entity ID** (from `GET /auth/saml/metadata`)

> **Note:** SAML SSO is restricted to the `surety_admin` role. Importer accounts must use email/password authentication (`POST /auth/login`).
