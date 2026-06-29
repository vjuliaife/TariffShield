# Security Model

This document describes TariffShield's authentication flow, role permissions, Soroban
on-chain authorization, data protection stance, and known limitations.

---

## Executive Summary

TariffShield protects two classes of assets: **on-chain collateral** (USDC/XLM held in
the Soroban contract) and **off-chain compliance data** (importer EINs, tariff CSVs,
bond documents stored in PostgreSQL).

**Actors and trust levels:**

| Actor | Trust | What they can do |
|-------|-------|-----------------|
| `importer` | Authenticated user | Deposit, withdraw excess collateral, raise disputes, view own state |
| `surety_admin` | Authenticated + license-verified | Clawback, accrue yield, view all importers, oracle alerts |
| Platform `admin` keypair | Soroban signer (`SECRET_KEY`) | Register importers, set required collateral on-chain, approve upgrades |
| Oracle admin keypair | Soroban signer (`ORACLE_SECRET_KEY`) | Set required collateral only (scoped oracle role, #339) |

**Mitigated threats:**

- Unauthorized collateral withdrawal — `withdraw_collateral` requires `importer.require_auth()` on-chain; the API enforces JWT ownership of the importer record.
- Rogue oracle — oracle admin key is separate from the platform admin key; a 5× cap guard and 24-hour rate limit bound the blast radius of a compromised oracle key.
- Surety over-reach — `clawback` can only be called by the on-chain `surety` address; the API additionally requires `surety_admin` role and a verified surety license.
- Brute-force — login is rate-limited at 10 failed attempts per 30-minute window; accounts are locked until the window expires.

---

## Authentication

### JWT issuance (`POST /auth/login`)

1. Client sends `{ email, password }`.
2. API looks up the user in PostgreSQL. If the account has an active `locked_until` timestamp (set after 10 failed attempts) the request is rejected with `403`.
3. `bcrypt.compare` (cost factor 12) validates the password against `password_hash`.
4. On success, `jsonwebtoken.sign` produces a **7-day HS256 JWT** signed with `JWT_SECRET`.
5. The token payload (`AuthPayload`) contains:
   ```ts
   { id: string; email: string; role: "importer" | "surety_admin" }
   ```
   There is no `exp` claim override — the library default of `"7d"` applies.

Signup (`POST /auth/signup`) follows the same path and additionally records privacy policy
acceptance and, for `surety_admin` accounts, inserts a pending `surety_license_verifications`
record that must be verified before licensed-only routes are accessible.

### SAML 2.0 SSO (surety admins, #308)

Surety admin accounts may authenticate via Okta or Azure AD using SP-initiated SAML 2.0.
The SP metadata is exposed at `GET /auth/saml/metadata`. On successful assertion the API
upserts the user (keyed by `saml_subject_id` + `idp_entity_id`) and returns a standard
JWT — downstream routes are unaware of the authentication method.

### Token validation (`authMiddleware`)

Every protected route applies `authMiddleware` from `apps/api/src/auth.ts`:

```ts
export function authMiddleware(req, res, next) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
    (req as AuthedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}
```

| Condition | HTTP status | Body |
|-----------|-------------|------|
| No `Authorization` header or not `Bearer` | 401 | `{ error: "missing bearer token" }` |
| Signature invalid or token malformed | 401 | `{ error: "invalid token" }` |
| Token expired (`exp` in the past) | 401 | `{ error: "invalid token" }` |
| Valid token | — | `req.user` set; `next()` called |

Role enforcement uses `requireRole(role)`:

```ts
export function requireRole(role: AuthPayload["role"]) {
  return (req, res, next) => {
    if ((req as AuthedRequest).user.role !== role) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
```

A `privacyReacceptanceGate` middleware additionally blocks all non-exempt routes with `403`
if the database indicates the user must re-accept an updated privacy policy (#322).

---

## Role Permissions Matrix

`✓` = accessible · `—` = 403 Forbidden · `*` = requires `surety_admin` + verified license

| Endpoint | `importer` | `surety_admin` |
|----------|-----------|----------------|
| `POST /auth/signup` | ✓ | ✓ |
| `POST /auth/login` | ✓ | ✓ |
| `GET /auth/me` | ✓ | ✓ |
| `POST /importers` | — | ✓ |
| `GET /importers` | — | ✓ |
| `GET /importers/:id` | ✓ (own only) | ✓ |
| `GET /importers/:id/collateral-status` | ✓ (own only) | ✓ |
| `POST /importers/:id/upload-tariff-csv` | ✓ (own only) | ✓ |
| `POST /importers/:id/deposit` | ✓ (own only) | — |
| `POST /importers/:id/auto-top-up` | ✓ (own only) | ✓ |
| `POST /importers/:id/withdraw` | ✓ (own only) | — |
| `POST /importers/:id/accrue-yield` | — | `*` |
| `POST /importers/:id/clawback` | — | `*` |
| `GET /admin/oracle-alerts` | — | ✓ |
| `PATCH /admin/oracle-alerts/:id/acknowledge` | — | ✓ |
| `GET /admin/roles` | — | ✓ |

---

## Soroban Authorization

The Soroban contract provides a second, independent authorization layer. API-level JWT
checks are insufficient on their own because any actor with access to the Soroban RPC
endpoint could bypass the API entirely.

### `require_auth()` usage in `lib.rs`

| Entrypoint | Who must authorize |
|---|---|
| `initialize` | All addresses in `admins` vec + `oracle_admin` |
| `register_importer` | `admins[0]` (platform admin keypair) |
| `deposit_collateral` / `deposit_reserve` | `from` (the depositing address) |
| `set_required_collateral` | `oracle_admin` keypair (#339) |
| `withdraw_collateral` | `importer` address |
| `accrue_yield` | `admins[0]` |
| `clawback` | `surety` address |
| `raise_dispute` | `importer` address |
| `resolve_dispute` | `admins[0]` |
| `propose_upgrade` / `approve_upgrade` | Admin address (must be in `admins` vec) |
| `rotate_oracle_admin` | `admins[0]` + `new_oracle_admin` |

### Why on-chain auth is necessary

The API uses a single **custodial platform keypair** (`SECRET_KEY`) to sign Soroban
transactions on behalf of importers for deposits and withdrawals. The contract's
`require_auth()` call is satisfied by this keypair for admin operations. Importer
operations that require the importer's own auth (`withdraw_collateral`, `raise_dispute`)
go through the Stellar Wallet Kit in the frontend — the private key never leaves the
browser.

The oracle admin key (`ORACLE_SECRET_KEY`) is intentionally separate from the platform
admin key. A compromised API server cannot arbitrarily inflate collateral requirements
beyond the 5× cap guard enforced on-chain.

---

## Data Protection

**PostgreSQL (off-chain)**
- `password_hash` is stored as a bcrypt hash (cost 12); plaintext passwords are never persisted.
- EIN (Employer Identification Number) is stored in plain text in the `importers` table; it is **not** encrypted at rest. This is a known gap (see Limitations below).
- Importer company names and addresses are stored in plain text.
- All API traffic is expected to run over HTTPS (enforced at the load-balancer / reverse proxy level; not enforced in the Express application itself).

**On-chain (Soroban)**
- Only `collateral_balance`, `required_collateral`, `reserve_balance`, `yield_accrued`, and `is_clawbacked` are stored on-chain. No PII is written to the ledger.
- Importer Stellar addresses on-chain are pseudonymous but publicly visible.

---

## Known Limitations and Security Roadmap

| Gap | Severity | Roadmap item |
|-----|----------|-------------|
| No refresh token rotation — the 7-day JWT cannot be revoked before expiry | Medium | Token blocklist or short-lived access + refresh token pair |
| No per-route rate limiting (only brute-force login throttle) | Medium | Express `rate-limiter-flexible` on sensitive routes |
| EIN stored in plaintext in PostgreSQL | Medium | Field-level encryption using `pgcrypto` |
| No HTTPS enforcement in Express (`helmet`, `hsts`) | Low | Add `helmet()` middleware with HSTS header |
| SAML assertion signature not fully validated (placeholder XML parser) | High | Replace with `passport-saml` for production SAML flows |
| Oracle admin key rotation requires a Soroban transaction — no automated key rotation | Medium | Hardware HSM integration for oracle signing key |
