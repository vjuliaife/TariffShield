# TariffShield

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vjuliaife/TariffShield)

> Programmable customs-bond collateral. US importers post yield-bearing USDC instead of dead-weight cash collateral; a Soroban smart contract auto-tops-up the bond during tariff spikes; the surety partner keeps emergency clawback authority.

A working end-to-end system on Stellar: one Soroban contract, a TypeScript SDK, a REST API, a web dashboard.

|                  |                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract address | [`CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF`](https://stellar.expert/explorer/testnet/contract/CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF) |
| Network          | Stellar (Soroban RPC, testnet)                                                                                                                                          |
| Collateral token | Native XLM SAC `CDLZFC3SYJ…CYSC` (stand-in for USDC; mainnet would use Circle USDC)                                                                                     |
| License          | MIT                                                                                                                                                                     |

See [PITCH.md](./PITCH.md) for the market case, [ARCHITECTURE.md](./ARCHITECTURE.md) for the technical deep-dive, and [docs/OPERATIONS_RUNBOOK.md](./docs/OPERATIONS_RUNBOOK.md) for the surety admin emergency clawback procedure.

---

## What it does

A US importer of consumer electronics doing $40M COGS from Shenzhen / Vietnam / Bangladesh needs a continuous customs bond. CBP sizes the bond at ~10% of expected annual duty obligation. The importer's surety asks for 50–100% **cash collateral** against that bond — held in a non-interest-bearing escrow account at the surety, for an average **314 days**. When tariffs spike (Section 301 hike, reciprocal regime, AD/CVD order), CBP places shipments on release hold until the bond is topped up. The importer either wires more cash (working capital hit) or watches freight pile up at port while D&D meters run.

TariffShield replaces that cash-with-surety arrangement with a Soroban escrow contract:

- The importer deposits USDC into a **collateral** bucket (what the bond requires) and a **reserve** bucket (auto-top-up pool)
- The platform acts as a tariff oracle — re-computing `required_collateral` from the importer's ACE Portal duty data
- When tariffs spike and required > collateral, anyone can call `auto_top_up` — the contract moves `min(shortfall, reserve)` from reserve to collateral atomically, no surety re-underwriting cycle
- Yield accrues to the importer via Franklin Templeton's BENJI tokenized T-bill (live integration on the roadmap)
- The surety retains a one-call emergency `clawback` authority on importer default — drains both buckets to the surety wallet and freezes the account

The system runs end-to-end on Stellar, so you can exercise the full flow without partnerships or licensing.

## Why this matters (the short version)

- **$3.6B** in customs bond insufficiencies in FY2025 — double 2019 (CBP)
- **27,479** distinct insufficiency events
- Surety premiums **up 200%** since the April 2025 reciprocal-tariff regime
- **~150,000** US continuous bonds in force; ~$10B aggregate face value; ~$5–10B in importer cash sitting in non-interest-bearing surety escrow accounts daily
- At a 4–5% T-bill yield, that's **$200–400M/year of forgone yield** for importers — every year

Existing surety SaaS (Roanoke, Avalon, GreatAmerican) is PDF + email driven. Nobody has a digital collateral instrument. We don't replace the surety — we replace the _collateral instrument they accept_. Same clawback authority, same regulatory posture; new cash mechanic.

Pricing model: 0.25–0.5% AUM, recurring. A 100-importer pilot at $1.5M average TVL is ~$150M TVL → $750K ARR; 10,000 importers is $75M ARR.

## Repo layout

```
tariffshield/
├── contracts/tariff-shield/        Rust Soroban contract (8 entrypoints, 14 tests, ~12KB wasm)
├── packages/sdk/                   TypeScript SDK wrapping the contract over Soroban RPC
├── apps/api/                       Express 5 + Postgres orchestrator + mock CBP CSV ingest
├── apps/web/                       Next.js 16 dashboard — importer + surety admin
├── scripts/                        Deployment, upgrade, and operations tooling
│   ├── backup-state.ts             Pre-upgrade state export to JSON + checksum
│   ├── verify-upgrade.ts           Post-upgrade verification suite
│   ├── rollback-upgrade.ts         Emergency rollback to previous wasm hash
│   ├── list-wasm-hashes.ts         Deployment history query tool
│   └── dep-graph.ts                Monorepo dependency graph generator
├── docker-compose.yml              Postgres on :5443
├── deployments.json                Contract ID + addresses + verification tx hashes
├── docs/dep-graph.md               Package dependency visualization
├── Cargo.toml                      Rust workspace
└── package.json                    npm workspaces
```

One git repo. `npm workspaces` resolves the TypeScript packages; `cargo workspace` resolves the Rust contract. `docker compose up` brings up Postgres. See [docs/dep-graph.md](./docs/dep-graph.md) for package dependency visualization.

## Full-stack Docker

Bring up the entire TariffShield stack — Postgres, API, web, and Jaeger — with a single command:

```bash
cp apps/api/.env.example apps/api/.env   # fill in secrets first
docker-compose up --build
```

| Service | URL |
|---|---|
| Web dashboard | http://localhost:3000 |
| REST API | http://localhost:3002 |
| Jaeger tracing UI | http://localhost:16686 |
| Postgres | localhost:5443 |

For hot-reload during development, `docker-compose.override.yml` mounts source directories automatically — no `--build` needed after editing TypeScript.

## Quick start with Dev Containers

The easiest way to get started is using GitHub Codespaces or the VS Code Dev Containers extension. The environment is pre-configured with Node.js, Rust, Docker, and the Soroban CLI.

1. Open the repository in [GitHub Codespaces](https://codespaces.new/vjuliaife/TariffShield) or open locally in VS Code and click **Reopen in Container**.
2. The container will automatically install dependencies, copy environment variables, and start the Postgres database.
3. Run the applications:
   ```bash
   npm run dev:api      # API on :3002
   npm run dev:web      # Web on :3000
   ```

## Quickstart

```bash
# 1. One-time toolchain
rustup target add wasm32-unknown-unknown
# stellar CLI: https://developers.stellar.org/docs/tools/cli

# 2. Install
git clone <this repo> tariffshield && cd tariffshield
npm install
(cd contracts/tariff-shield && cargo build --target wasm32-unknown-unknown --release)

# 3. Local Postgres
docker compose up -d

# 4. Configure env
cp .env.example .env
cp .env apps/api/.env                # API reads from apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 5. Run
npm run dev:api      # API on :3002
npm run dev:web      # Web on :3000
```

Open http://localhost:3000.

The pre-deployed contract works out of the box — your `.env.example` already points at `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF`. To deploy your own:

```bash
stellar keys generate --fund my-admin --network testnet
stellar contract deploy \
  --network testnet \
  --source-account my-admin \
  --wasm target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm
# then `stellar contract invoke <C…> -- initialize --admin <G…> --surety <G…> --token <SAC…>`
```

Replace `TARIFF_SHIELD_CONTRACT_ID` in your `.env`.

## Verification flow

The full happy path runs end-to-end:

1. **Signup as importer.** `POST /auth/signup` — creates a user record.
2. **Register importer.** `POST /importers` — backend generates a Stellar keypair, funds it via friendbot, calls `register_importer` on-chain. Example tx [`b50f2090…f161f5`](https://stellar.expert/explorer/testnet/tx/b50f2090b008bd3f91d7760745aef9624fd1a8f31e7d4cc11862e80b937161f5).
3. **Deposit 30 XLM collateral + 100 XLM reserve.** Two contract calls. Example tx [`dbc981c6…87daa`](https://stellar.expert/explorer/testnet/tx/dbc981c69affacbbe3e0a284983d221e6528225f0c1a916da290ceef70587daa).
4. **Upload tariff CSV.** Platform recomputes `required_collateral` from `annual_duty × 10% × 50%`. Creates a shortfall scenario.
5. **`auto_top_up`** — moves the exact shortfall (50 XLM) from reserve to collateral atomically.
6. **Accrue simulated yield** (surety admin role).
7. **`clawback`** (surety admin, on default scenario) — drains 130 XLM to surety wallet + freezes the account. Example tx [`fb698e46…96ca19`](https://stellar.expert/explorer/testnet/tx/fb698e46c82d911bad8f9dafe6440f9edbfcb6b5f5f7a7d85d7eb1981496ca19).

All seven steps run as real on-chain transactions. The full set of verification tx hashes lives in `deployments.json`.

## Stack

| Layer          | Choice                                                                      |
| -------------- | --------------------------------------------------------------------------- |
| Smart contract | Rust 1.94 + soroban-sdk 22 + stellar CLI 25.2                               |
| Contract tests | `cargo test` (14 unit tests, all pass)                                      |
| SDK            | TypeScript 5 + `@stellar/stellar-sdk` 15 (Soroban RPC)                      |
| API            | Express 5 + Postgres 17 + bcryptjs + JWT + Zod + helmet + rate-limit + CORS |
| Web            | Next.js 16 + Tailwind v4 (App Router, Turbopack)                            |
| Deploy         | Render (API) + Vercel (web) + Neon (Postgres) + Stellar (contract)          |

## What's intentionally out of scope

The current build pairs the on-chain contract with synthetic CBP data and a mock surety admin. The production gap is non-trivial; the roadmap in [ARCHITECTURE.md](./ARCHITECTURE.md#roadmap) lists 16 specific items, but the four real gates are:

1. **Surety partnership.** Production routing through a state-licensed surety requires a 6–12 month sales cycle with one of Roanoke / Avalon / GreatAmerican / Liberty Mutual. The system runs without it.
2. **CBP ACE API access.** Not publicly accessible — needs surety-side relay or per-importer OAuth. The system uses CSV upload for tariff-exposure ingestion.
3. **Real BENJI integration.** Franklin Templeton's tokenized T-bill is already on Stellar at $270M+ TVL but routing real fund flow requires a custody agreement. Today, yield accrual is recorded on-chain by the platform admin.
4. **State-by-state insurance regulator approval.** Sureties are regulated in every US state. Changing the collateral instrument backing a bond is an insurance question, not just a CBP question.

These gates are GTM, not technical. The technology, end-to-end, works today.

## Troubleshooting

Running into a setup or runtime error? Check **[docs/FAQ.md](./docs/FAQ.md)** for the 10 most common issues with copy-paste fixes:

- Postgres connection refused on startup
- Missing `.env` file crash
- Soroban RPC timeout or SSL error
- `cargo build` missing libpq / OpenSSL
- XDR decoding panic in the Stellar SDK
- `npm install` peer dependency conflicts
- Friendbot 400 error on testnet
- `NEXT_PUBLIC_*` vars not visible in the browser
- JWT token expired during development
- `docker-compose` port conflict on 5432

## API Documentation

The REST API ships with an OpenAPI 3.1 specification and an interactive Swagger UI:

| Endpoint | Description |
|---|---|
| `GET /docs` | Swagger UI (rendered in browser) |
| `GET /docs/openapi.json` | Raw OpenAPI 3.1 spec (JSON) |

Start the API (`npm run dev:api`) then open [http://localhost:3002/docs](http://localhost:3002/docs).

The spec covers all 30+ routes across Auth, Importers, KYC, Compliance, Surety License, and Health, with request/response schemas and JWT security requirements on each protected route.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a full history of releases following the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## License

MIT. Contributions welcome — the roadmap section in [ARCHITECTURE.md](./ARCHITECTURE.md) lists scoped tasks with effort labels.
