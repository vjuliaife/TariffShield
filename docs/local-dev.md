# Local Development Guide

This guide covers everything you need to know to run the TariffShield stack locally.

## Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js 20+**: [Download](https://nodejs.org/)
- **npm 10+**: Included with Node.js
- **Docker Desktop**: [Download](https://www.docker.com/products/docker-desktop/)
- **Rust stable**: [Install via rustup](https://rustup.rs/)
- **wasm32 target**: Run `rustup target add wasm32-unknown-unknown`
- **Stellar CLI**: [Installation Guide](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
- **Recommended Editor**: VS Code with rust-analyzer and ESLint extensions

## Environment Setup

1. Copy the example environment file for the API:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

2. Configure your API `.env` variables:

| Variable | Description | Requirement |
|----------|-------------|-------------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `PORT` | API server port (default 3002) | Optional |
| `JWT_SECRET` | Secret for signing tokens | Required |
| `TARIFF_SHIELD_CONTRACT_ID`| Soroban Contract ID | Required |
| `STELLAR_NETWORK_PASSPHRASE`| Soroban network passphrase | Required |

3. Copy the example environment file for the Web application:
   ```bash
   cp apps/web/.env.example apps/web/.env.local
   ```

## Local Database

We use Docker Compose to run a local PostgreSQL instance.

1. Start the database in the background:
   ```bash
   docker-compose up -d
   ```
2. Verify PostgreSQL is running:
   ```bash
   docker-compose ps
   ```
3. The API will automatically run migrations on startup.

## Running the Stack

Install all dependencies from the monorepo root:
```bash
npm install
```

### 1. Start the API
In a new terminal window:
```bash
npm run dev --workspace=@tariffshield/api
```
The API should now be running at `http://localhost:3002`.

### 2. Start the Web Application
In another terminal window:
```bash
npm run dev --workspace=@tariffshield/web
```
The dashboard should now be accessible at `http://localhost:3000`.

### 3. Health Verification
You can check the API health by visiting:
```bash
curl http://localhost:3002/health
```

## Smoke Test Workflow

To verify your local environment is fully operational:
1. Navigate to `http://localhost:3000/signup`.
2. **Signup** for a new account.
3. **Login** to access the dashboard.
4. Complete the **Importer registration** flow.
5. Validate the health endpoint shows `db: "connected"` and `soroban: "ok"`.

### Shortfall demo (`--shortfall`)

The seed script (#1140) can pre-stamp one demo importer in the shortfall
scenario the README "Verification flow" describes:

```bash
npm run seed -- --shortfall
npm run admin -- auto-top-up --importer-id <id printed by the seeder>
```

`demo-importer-shortfall@example.com` ships with the deposits (30 XLM
collateral + 100 XLM reserve) and the tariff upload that drives required
collateral to 80 XLM, so `auto-top-up` deterministically reports a 50 XLM
move (reserve → collateral), matching the documented flow. The admin command
derives the numbers from `contract_events`/`tariff_uploads` when the importer
is a DB-only demo (dry-run), and from the live on-chain account — submitting
with `--execute` — once the importer is really registered and funded.

## Common Issues

- **Port Conflicts**: If port 3002 or 5432 is already in use, update the respective `.env` or `docker-compose.yml` configuration.
- **Missing Environment Variables**: Ensure your `JWT_SECRET` and Stellar-related variables are correctly populated in `.env`.
- **Docker Startup Failures**: Ensure Docker Desktop is running. Try `docker-compose down` followed by `docker-compose up -d`.
