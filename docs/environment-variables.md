# Environment Variable Reference

TariffShield is a monorepo. Each service (`apps/api`, `apps/web`) has its own `.env` file. Variables are **not** automatically shared between services — the API server and the Next.js frontend each read only their own environment.

Copy the relevant `.env.example` file to `.env` in the same directory and fill in the values before starting each service.

---

## API Service — `apps/api/.env`

Source of truth for these descriptions is the Zod schema in `apps/api/src/config/env.ts`. The schema validates all variables at startup and exits with a descriptive error if any required variable is missing or invalid.

### Core

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `PORT` | No (default: `3002`) | Port the Express API listens on | `3002` |
| `NODE_ENV` | No (default: `development`) | Application environment. Accepted: `development`, `production`, `test` | `development` |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. Append `?sslmode=require` for managed databases | `postgres://tariffshield:secret@localhost:5443/tariffshield` |
| `FRONTEND_ORIGIN` | No (default: `http://localhost:3000`) | CORS allowed origin for the web frontend | `http://localhost:3000` |

### Authentication

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `JWT_SECRET` | **Yes** | Secret key for signing HS256 JSON Web Tokens. Minimum 32 characters. Use a 64-character hex string in production | `a1b2c3d4e5f6...` (64 hex chars) |

### Stellar Network

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `STELLAR_NETWORK` | No (default: `testnet`) | Stellar network to connect to. Accepted: `testnet`, `public` | `testnet` |
| `STELLAR_RPC_URL` | **Yes** | Soroban RPC endpoint. See [Network Configuration](#network-configuration) for canonical URLs | `https://soroban-testnet.stellar.org` |
| `STELLAR_HORIZON_URL` | **Yes** | Stellar Horizon REST API endpoint | `https://horizon-testnet.stellar.org` |
| `STELLAR_NETWORK_PASSPHRASE` | **Yes** | Stellar network passphrase used to sign transactions. Must match `STELLAR_NETWORK` | `Test SDF Network ; September 2015` |

### Contract & Keypairs

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `TARIFF_SHIELD_CONTRACT_ID` | **Yes** | Deployed Soroban contract address (starts with `C`, 56 chars) | `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF` |
| `PLATFORM_STELLAR_SECRET` | **Yes** | Platform admin Stellar secret key (starts with `S`, 56 chars). Signs `register_importer`, `set_required_collateral`, `auto_top_up` transactions | `SCZANGBA5AKIA...` |
| `SURETY_STELLAR_SECRET` | **Yes** | Surety provider Stellar secret key. Signs `clawback` transactions | `SDKXDGXQP...` |
| `ORACLE_STELLAR_SECRET` | No | Separate oracle-role Stellar secret key (#339). If not set, falls back to `PLATFORM_STELLAR_SECRET` | `SBBBBB...` |
| `ADMIN_2_SECRET` | No | Second admin Stellar secret key for multi-sig contract upgrade proposals | `SAAAAA...` |
| `ADMIN_3_SECRET` | No | Third admin Stellar secret key for multi-sig contract upgrade proposals | `SCCCCCC...` |

### Tariff & Oracle

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `CBP_VALIDATION_MODE` | No (default: `block`) | Behaviour when a CBP duty rate lookup shows > 10% deviation from submitted rates. `block` returns 422; `warn` logs and continues | `block` |
| `ORACLE_ALERT_THRESHOLD_PCT` | No (default: `50`) | Percentage change in required collateral that triggers an oracle alert record | `50` |
| `ALERT_CHANNEL` | No (default: `console`) | Alert delivery channel for oracle monitor. Currently only `console` is implemented | `console` |

### Metrics

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `METRICS_ALLOWED_CIDR` | No | CIDR block allowed to access the `GET /metrics` Prometheus endpoint. If unset, the endpoint is open | `10.0.0.0/8` |

### SAML 2.0 SSO (optional)

All SAML variables are optional. If not set, the SAML endpoints return `501`.

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `SAML_SP_ENTITY_ID` | No | Service Provider entity ID, typically the metadata URL | `https://tariffshield.io/saml/metadata` |
| `SAML_SP_ACS_URL` | No | Assertion Consumer Service callback URL | `https://tariffshield.io/auth/saml/okta/callback` |
| `SAML_SP_PRIVATE_KEY` | No | PEM private key used to sign AuthnRequests (production only) | `-----BEGIN PRIVATE KEY-----\n...` |
| `SAML_OKTA_ENTRY_POINT` | No | Okta SSO entry point URL from your Okta application | `https://dev-123.okta.com/app/.../sso/saml` |
| `SAML_OKTA_CERT` | No | Okta IdP X.509 certificate (PEM format, no `-----BEGIN CERTIFICATE-----` headers) | `MIIC...` |
| `SAML_AZURE_ENTRY_POINT` | No | Azure AD SSO entry point URL | `https://login.microsoftonline.com/<tenant>/saml2` |
| `SAML_AZURE_CERT` | No | Azure AD IdP X.509 certificate (PEM, no headers) | `MIIC...` |

### DocuSign Electronic Signatures (optional)

All DocuSign variables are optional. If not set, bond-signature endpoints operate in stub mode.

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `DOCUSIGN_INTEGRATION_KEY` | No | DocuSign OAuth integration (client) key | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `DOCUSIGN_USER_ID` | No | DocuSign API user ID (impersonated user) | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `DOCUSIGN_ACCOUNT_ID` | No | DocuSign account ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `DOCUSIGN_BASE_PATH` | No | DocuSign base API URL. Use demo URL for testing | `https://demo.docusign.net/restapi` |
| `DOCUSIGN_PRIVATE_KEY` | No | RSA private key for DocuSign JWT grant (PEM format) | `-----BEGIN RSA PRIVATE KEY-----\n...` |
| `DOCUSIGN_WEBHOOK_HMAC_KEY` | No | HMAC key for verifying DocuSign Connect webhook signatures | `random-64-char-secret` |

### Field-Level Encryption

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `FIELD_ENCRYPTION_KEY` | No | AES-256-GCM key for encrypting EIN and PII fields at rest. Minimum 32 characters. In production, derive from AWS KMS or HashiCorp Vault | `your-32-char-minimum-aes-key-here!!` |
| `FIELD_ENCRYPTION_KEY_VERSION` | No (default: `1`) | Active key version number. Increment when rotating keys | `1` |

### Document Storage (optional)

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `S3_KYC_BUCKET` | No | S3 bucket name for KYC document storage (SSE-KMS encrypted, 5-year BSA retention) | `tariffshield-kyc-prod` |
| `S3_REPORTS_BUCKET` | No | S3 bucket name for compliance report PDFs | `tariffshield-reports-prod` |
| `AWS_REGION` | No (default: `us-east-1`) | AWS region for S3 and KMS operations | `us-east-1` |

### Notifications (optional)

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `SENDGRID_API_KEY` | No | SendGrid API key for compliance report email notifications | `SG.xxxxxxx` |
| `REPORT_FROM_EMAIL` | No | From address for compliance report notification emails | `reports@tariffshield.io` |

---

## Web Service — `apps/web/.env`

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `NEXT_PUBLIC_API_URL` | **Yes** | Base URL of the API service, accessible from the browser | `http://localhost:3002` |
| `NEXT_PUBLIC_STELLAR_NETWORK` | No (default: `testnet`) | Stellar network the frontend connects to. Must match the API's `STELLAR_NETWORK` | `testnet` |
| `NEXT_PUBLIC_CONTRACT_ID` | **Yes** | TariffShield Soroban contract address. Must match the API's `TARIFF_SHIELD_CONTRACT_ID` | `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF` |

`NEXT_PUBLIC_*` variables are inlined into the browser bundle at build time. Any variable without the prefix is available only during Next.js server-side rendering and API routes.

---

## Sensitive Variables

The following variables must **never** be committed to source control. They grant signing authority over funds, decrypt stored PII, or allow database access:

| Variable | Risk if Leaked |
|----------|---------------|
| `JWT_SECRET` | Attacker can forge valid session tokens for any user |
| `DATABASE_URL` | Direct database access, including all PII and financial records |
| `PLATFORM_STELLAR_SECRET` | Can register importers and trigger collateral changes on-chain |
| `SURETY_STELLAR_SECRET` | Can trigger clawback (emergency fund seizure) on any importer |
| `ORACLE_STELLAR_SECRET` | Can manipulate required collateral amounts on-chain |
| `ADMIN_2_SECRET`, `ADMIN_3_SECRET` | Can participate in multi-sig contract upgrades |
| `FIELD_ENCRYPTION_KEY` | Can decrypt stored EINs and PII fields |
| `DOCUSIGN_PRIVATE_KEY` | Can impersonate the DocuSign integration to send or complete envelopes |
| `DOCUSIGN_WEBHOOK_HMAC_KEY` | Can forge DocuSign webhook events |

**In production**, store these in a secrets manager (AWS Secrets Manager, HashiCorp Vault, or equivalent) and inject them into the process environment at runtime. Do not hardcode them in Dockerfiles, CI configuration, or any file tracked by git.

The `.gitignore` at the root of this repository excludes `.env` files. Never use `git add -f` to force-add them.

---

## Network Configuration

The `STELLAR_RPC_URL` and `STELLAR_HORIZON_URL` values differ per environment:

| Environment | `STELLAR_NETWORK` | `STELLAR_RPC_URL` | `STELLAR_HORIZON_URL` |
|-------------|-------------------|--------------------|-----------------------|
| Local (Docker) | `testnet` | `http://localhost:8000/soroban/rpc` | `http://localhost:8000` |
| Testnet | `testnet` | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` |
| Mainnet | `public` | `https://soroban-testnet.stellar.org` *(replace with RPC provider)* | `https://horizon.stellar.org` |

For mainnet, use a dedicated RPC provider (e.g. Quicknode, Blockdaemon) rather than the public endpoint; the public endpoint has strict rate limits and no SLA.

`STELLAR_NETWORK_PASSPHRASE` values:
- Testnet: `Test SDF Network ; September 2015`
- Mainnet: `Public Global Stellar Network ; September 2015`

---

## Keeping `.env.example` in Sync

When adding a new environment variable:

1. Add it to the Zod schema in `apps/api/src/config/env.ts` with a `.describe()` annotation.
2. Add it to `apps/api/.env.example` with a commented example value and a `# [Required]` or `# [Optional]` prefix.
3. Add a row to the relevant table in this document.

To enforce that all required variables are present before the server starts, the schema validates at import time and calls `process.exit(1)` with a descriptive error for each missing or invalid variable.

For CI enforcement, consider adding [`dotenv-safe`](https://github.com/rolodato/dotenv-safe) or [`envsafe`](https://github.com/KATT/envsafe) to the project and checking that all keys in `.env.example` exist in the test environment before running integration tests.
