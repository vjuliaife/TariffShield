# SOC 2 CC6 — Logical and Physical Access Controls

This document maps TariffShield's technical access controls to the SOC 2 Type II Trust Services Criteria for Logical and Physical Access (CC6). Each control identifies the implementing source file, the audit evidence it produces, and its current implementation status.

---

## CC6.1 — Logical Access Security Measures

> The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events to meet the entity's objectives.

### Authentication

| Control | Implementation | File | Evidence |
|---------|---------------|------|----------|
| Password hashing | bcrypt, cost factor 12 | `apps/api/src/auth.ts` → `hashPassword()` | `password_hash` column in `users` table never stores plaintext |
| JWT issuance | HS256, 7-day TTL | `apps/api/src/auth.ts` → `signToken()` | `JWT_SECRET` environment variable; token payload contains `id`, `email`, `role`, `sessionId` |
| Bearer token validation | Every request to protected routes | `apps/api/src/auth.ts` → `authMiddleware()` | 401 on missing or expired token; logged in application stdout |
| Session creation | On every successful login, signup, and SAML SSO callback | `apps/api/src/routes/auth.ts` login, signup, and SAML callback handlers | Row in `user_sessions` table with `created_at`, `ip_address`, `user_agent`; `sessionId` always embedded in issued JWT |
| Session inactivity timeout | 15 minutes of no API activity | `apps/api/src/auth.ts` → `authMiddleware()` + `apps/api/src/db.ts` → `validateSession()` | Session row `last_activity` checked on every request; expired session → 401; DB unavailable → 503 (fail-closed, never fail-open) |
| Session revocation on logout | `POST /auth/logout` | `apps/api/src/routes/auth.ts` logout handler | `revoked_at` set on `user_sessions` row |
| Concurrent session limits | 5 (importer), 3 (surety_admin) | `apps/api/src/auth.ts` → `MAX_SESSIONS`; enforced in `apps/api/src/routes/auth.ts` login handler | Oldest session revoked before new session is issued when limit is reached |

### Multi-Factor Authentication (Compensating Control)

MFA for `surety_admin` and `admin` roles is implemented as a compensating control at the identity provider (IdP) level for SSO-connected accounts (Okta, Azure AD). For password-based accounts, MFA enforcement is documented as a pre-production requirement. Brute-force protection (see CC6.6) provides a compensating control in the interim.

**Action required before production:** Configure mandatory MFA policies in the Okta and Azure AD tenants that issue SAML assertions to TariffShield. For password-based `surety_admin` accounts, implement TOTP verification using a library such as `otplib` before granting access to clawback or accrue-yield operations.

---

## CC6.2 — Access Provisioning and Deprovisioning

> Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users.

| Control | Implementation | File | Evidence |
|---------|---------------|------|----------|
| Role assignment at signup | `role` field validated against `["importer", "surety_admin"]` | `apps/api/src/routes/auth.ts` `SignupSchema` | `users.role` column; CHECK constraint in `apps/api/src/db.ts` |
| Surety admin license gate | New `surety_admin` accounts blocked from operational routes until NAIC license is verified | `apps/api/src/routes/surety-license.ts` → `requireLicenseVerified()` | `surety_license_verifications.status` column; 403 returned until status = `"verified"` |
| Stale account review | `GET /admin/access-review?days=90` returns all accounts with no successful login in the past N days | `apps/api/src/routes/admin.ts` + `apps/api/src/db.ts` → `getStaleAccounts()` | Query result from `authentication_attempts` grouped by `user_id` |
| Quarterly access review cadence | Run `GET /admin/access-review` every quarter and deprovision stale accounts | Process requirement | Output JSON list of stale accounts with `last_login` timestamp |

---

## CC6.3 — Role-Based Access Control

> The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on roles, responsibilities, or the system design and related policies.

### Role Definitions

| Role | Description | How Assigned |
|------|-------------|--------------|
| `importer` | U.S. customs importer managing their own bond collateral account | Set at `POST /auth/signup` (default) |
| `surety_admin` | Licensed surety company employee managing importer bonds and performing clawbacks | Set at `POST /auth/signup` with `role: "surety_admin"`; blocked until NAIC license verified |
| `admin` (platform) | TariffShield platform operator with Stellar keypair access | Not a JWT role; operates via `PLATFORM_STELLAR_SECRET` and direct database access |

### Access Matrix

The authoritative access matrix constant is in `apps/api/src/auth.ts` → `ROLE_PERMISSIONS`. A summary:

| Resource | importer | surety_admin |
|----------|----------|--------------|
| Register own importer account | ✅ | ❌ |
| View own importer details | ✅ | ✅ (all importers) |
| Deposit / withdraw collateral | ✅ (KYC-gated, own only) | ❌ |
| Upload tariff CSV | ✅ (own only) | ❌ |
| Accrue yield | ❌ | ✅ (license-verified) |
| Clawback collateral | ❌ | ✅ (license-verified) |
| View oracle alerts | ❌ | ✅ |
| Publish privacy policy | ❌ | ✅ |
| Access review (stale accounts) | ❌ | ✅ |
| KYC document review | ❌ | ✅ |
| Compliance dashboard | ❌ | ✅ |

Enforcement mechanism: `authMiddleware` validates JWT and attaches the `role` claim; individual route handlers and `requireRole()` / `requireLicenseVerified()` middleware enforce the matrix per route.

---

## CC6.6 — Threats from Outside System Boundaries

> The entity implements controls to prevent or detect and act upon the introduction of unauthorized or malicious software.

| Control | Implementation | File | Evidence |
|---------|---------------|------|----------|
| Brute-force lockout | 10 failed login attempts within 30 minutes triggers 30-minute lockout and P1 security incident | `apps/api/src/routes/auth.ts` login handler + `apps/api/src/db.ts` → `getFailedAuthAttempts()`, `recordSecurityIncident()` | `authentication_attempts` table; `security_incidents` table |
| Account lock enforcement | `locked_until` checked before password comparison | `apps/api/src/routes/auth.ts` login handler | `users.locked_until` column |
| OFAC sanctions screening | All new importer registrations screened before DB write | `apps/api/src/routes/importers.ts` → `screenImporterEntity()` | `aml_screenings` table |
| AML wallet screening | Wallet address screened at importer creation and on deposit/withdrawal | `apps/api/src/routes/importers.ts` | `aml_screenings` table |
| Dependency vulnerability scanning | `npm audit --audit-level=high` on every PR | `.github/workflows/ci.yml` `audit` job | GitHub Actions logs; PR blocked on high-severity finding |
| Static code analysis (SAST) | CodeQL JavaScript/TypeScript analysis weekly and on push to main | `.github/workflows/codeql.yml` | GitHub Security tab findings |

---

## CC6.7 — Transmission and Storage Protections

| Control | Implementation | File | Evidence |
|---------|---------------|------|----------|
| EIN field encryption | AES-256-GCM at application layer | `apps/api/src/` (field-encryption service) | `importers.ein_encrypted` + `importers.ein_key_version` columns |
| KYC document encryption | SSE-KMS on S3 + application-layer encryption of S3 key | `apps/api/src/routes/kyc.ts` | `kyc_documents.s3_key_encrypted` column |
| HTTPS in transit | Enforced at infrastructure layer (reverse proxy / Vercel) | Infrastructure configuration | TLS certificate |
| Database SSL | `sslmode=require` enforced in production `DATABASE_URL` | `apps/api/src/db.ts` | Connection string validation |

---

## CC6.8 — Unauthorized Access Prevention

| Control | Implementation | File | Evidence |
|---------|---------------|------|----------|
| Privacy policy re-acceptance gate | 403 on all protected routes when `privacy_reacceptance_required = TRUE` | `apps/api/src/auth.ts` → `privacyReacceptanceGate()` | `users.privacy_reacceptance_required` column |
| Surety license verification gate | Clawback and accrue-yield require verified NAIC license | `apps/api/src/routes/surety-license.ts` → `requireLicenseVerified()` | `surety_license_verifications.status` column |
| Authentication attempt audit log | Every login attempt (success and failure) recorded | `apps/api/src/db.ts` → `recordAuthenticationAttempt()` | `authentication_attempts` table |
| Session audit trail | Sessions created, touched, and revoked with timestamp and IP | `apps/api/src/db.ts` session helpers | `user_sessions` table |
| Contract event audit trail | Every on-chain action mirrored to DB | `apps/api/src/routes/importers.ts` | `contract_events` table |

---

## Change Management

Schema changes are introduced via the `migrate()` function in `apps/api/src/db.ts` using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, making every schema change idempotent and auditable via git history.

All API route changes and schema modifications require:
1. A pull request against `main` in the GitHub repository.
2. At least one reviewer approval before merge.
3. The CI jobs (`test`, `typecheck`, `lint`, `audit`) must pass.

The git commit history and GitHub PR review records serve as the formal change management log. Significant changes reference the issue number (e.g. `#306`) in the commit message for traceability.

---

## MFA Requirement Statement

> SOC 2 CC6.1 requires that privileged and administrator accounts use multi-factor authentication.

TariffShield satisfies this requirement as follows:

- **SSO accounts** (`surety_admin` via Okta or Azure AD): MFA is enforced at the IdP level. The SAML assertion received by TariffShield presupposes IdP-enforced MFA; operators must enable MFA policies in their Okta / Azure tenants before going live.
- **Password-based `surety_admin` accounts**: A TOTP-based second factor (e.g. Google Authenticator via `otplib`) must be implemented and enforced before the production launch of any surety admin account using password authentication. This is a documented pre-production requirement tracked as a control gap.
- **`importer` accounts**: MFA is not required; brute-force protection (10-attempt lockout) serves as the compensating control.
- **Platform admin (`admin`)**: Access is via Stellar keypair (`PLATFORM_STELLAR_SECRET`), which is stored in a secrets manager and never exposed through the API surface. Keypair access control (HSM, Vault policy, IAM role) is the equivalent of MFA for this role.
