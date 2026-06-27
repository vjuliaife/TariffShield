# Changelog

All notable changes to TariffShield will be documented in this file.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.
TariffShield adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Live CBP ACE API integration via surety relay
- Sumsub / Smile Identity KYC for importer onboarding
- Real Franklin Templeton BENJI yield routing
- Mainnet config + Circle USDC swap (KYC asset with `auth_required` + `clawback` flags)
- Encrypted-at-rest importer Stellar secrets (AES-256-GCM)
- Surety admin SAML claims-history export
- Per-state surety insurance regulator filings
- Tariff-spike alert system (email + SMS via Twilio)
- Multi-importer-entity support (subsidiaries, related parties)
- Path-payment fallback when surety wallet currency ≠ USDC
- SOC 2 Type II + ISO 27001 prep
- On-chain immutable event log export for state regulators
- CI: `cargo test` + WASM size budget gate
- Indexer: subscribe to contract events via Soroban RPC → populate Postgres mirror
- Bond-policy templates (continuous vs single-entry vs ATA Carnet)
- Hardware wallet support for surety admin (Ledger via stellar-base)

---

## [0.1.0] — 2026-05-18

### Added

**Soroban Smart Contract (`contracts/tariff-shield/src/lib.rs`)**

- `initialize` — deploys the contract and sets the admin, surety, and USDC token addresses; stores the dispute window and multi-sig upgrade threshold
- `register_importer` — registers an importer account on-chain and assigns a bond ID with a required collateral amount
- `deposit_collateral` — transfers USDC from the importer's wallet into the contract escrow; emits `DepositEvent`
- `deposit_reserve` — allows the surety or admin to top up the reserve pool separately from importer collateral
- `withdraw_collateral` — returns escrowed USDC to the importer after verifying the bond is in good standing
- `accrue_yield` — credits simulated yield (Franklin Templeton BENJI placeholder) to an importer's on-chain balance
- `auto_top_up` — automatically moves funds from the reserve pool to an importer whose collateral has fallen below the required threshold; emits `AutoTopUpEvent`
- `clawback` — irreversibly transfers an importer's full collateral balance to the surety wallet upon default or regulatory directive; emits `ClawbackEvent`
- `raise_dispute` — allows an importer to open a formal dispute against a clawback or reserve action; emits `DisputeRaisedEvent`
- `resolve_dispute` — allows the surety to accept or reject a dispute; emits `DisputeResolvedEvent`
- `set_required_collateral` — admin-only update to an importer's required collateral threshold
- `get_account` — returns the full on-chain account state for an importer (balances, bond ID, dispute status)
- `is_collateral_stale` — returns `true` if the importer's collateral has not been updated within the configured staleness window
- `get_collateral_history` — returns a chronological log of all collateral changes for an importer
- `propose_upgrade` / `approve_upgrade` / `cancel_upgrade` — multi-sig two-of-three contract upgrade mechanism; upgrade requires two admin approvals before WASM replacement
- `get_admin`, `get_surety`, `get_token` — read-only accessors for core contract configuration

**REST API (`apps/api/src/routes/`)**

- `POST /auth/signup` — create a new surety admin account (bcrypt-hashed password, JWT issued)
- `POST /auth/login` — authenticate and receive a signed JWT
- `GET /auth/me` — return the authenticated user's profile
- `GET /auth/saml/metadata` — serve SAML SP metadata XML for identity provider configuration
- `GET /auth/saml/:provider/login` — initiate SAML SSO login flow
- `POST /auth/saml/:provider/callback` — handle SAML assertion and issue a session JWT
- `POST /importers` — register a new importer; provisions a Stellar keypair and persists the account
- `GET /importers` — list all importers with pagination and optional status filter
- `GET /importers/:id` — retrieve a single importer record with on-chain state
- `GET /importers/:id/collateral-status` — return live collateral health (current vs required, staleness flag)
- `POST /importers/:id/upload-tariff-csv` — parse and store a CBP-format tariff schedule CSV; validates column headers and duty rates
- `POST /importers/:id/deposit` — build and submit an on-chain `deposit_collateral` transaction
- `POST /importers/:id/auto-top-up` — trigger `auto_top_up` for the importer from the reserve pool
- `POST /importers/:id/withdraw` — build and submit an on-chain `withdraw_collateral` transaction
- `POST /importers/:id/accrue-yield` — trigger `accrue_yield` for the importer (surety-licensed callers only)
- `POST /importers/:id/clawback` — execute the `clawback` entrypoint (surety-licensed callers only); records audit log entry
- `GET /health` — liveness probe returning service name and timestamp

**TypeScript SDK (`packages/sdk/src/index.ts`)**

- `TariffShieldClient` class wrapping all contract entrypoints as typed async methods: `initialize`, `registerImporter`, `depositCollateral`, `depositReserve`, `withdrawCollateral`, `accrueYield`, `autoTopUp`, `clawback`, `raiseDispute`, `resolveDispute`, `getAccount`, `isCollateralStale`, `getCollateralHistory`
- Soroban RPC integration using `@stellar/stellar-sdk` with configurable network passphrase and RPC URL

**Next.js Web Interface (`apps/web/`)**

- Surety admin dashboard with importer list, collateral status cards, and action buttons for deposit, withdrawal, clawback, and yield accrual
- Importer onboarding flow: signup → KYC placeholder → bond agreement → initial deposit
- Login and signup pages with JWT session management
- Tariff CSV upload UI with drag-and-drop and column-mapping preview

**Infrastructure**

- Docker Compose stack: PostgreSQL 16, API server, Next.js web app, and optional local Stellar testnet node
- Database migration system (`apps/api/src/db.ts`) with schema for `importers`, `tariff_entries`, `contract_events`, `surety_licenses`, `audit_log`, and `privacy_acceptances` tables
- Zod-validated environment loader (`apps/api/src/env.ts`) with required and optional variable enforcement
- Rate limiting (express-rate-limit), CORS, and Helmet HTTP security headers on all API routes

### Security

- JWT authentication on all importer API routes via `authMiddleware`; tokens signed with `JWT_SECRET` and expire after a configurable TTL
- `require_auth()` Soroban guard on all privileged contract functions (`clawback`, `withdraw_collateral`, `accrue_yield`, `set_required_collateral`, `propose_upgrade`, `approve_upgrade`, `cancel_upgrade`), preventing unsigned invocations
- Bcrypt password hashing (cost factor 12) for surety admin credentials
- Surety license verification gate (`requireLicenseVerified`) on clawback and yield accrual endpoints to prevent unauthorised financial actions
- Privacy policy re-acceptance gate enforced on every importer route after a policy version change

[Unreleased]: https://github.com/vjuliaife/TariffShield/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vjuliaife/TariffShield/releases/tag/v0.1.0
