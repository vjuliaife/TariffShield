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
- **Recommended Editor**: VS Code with [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer), [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint), and [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) extensions. The repository includes [`.vscode/settings.json`](../.vscode/settings.json) to enable automatic format-on-save via Prettier for TypeScript/JSON/YAML/Markdown while deferring Rust formatting to rust-analyzer and `rustfmt.toml`.

## Environment Setup

1. Copy the example environment file for the API:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

2. Configure your API `.env` variables:

| Variable                     | Description                    | Requirement |
| ---------------------------- | ------------------------------ | ----------- |
| `DATABASE_URL`               | PostgreSQL connection string   | Required    |
| `PORT`                       | API server port (default 3002) | Optional    |
| `JWT_SECRET`                 | Secret for signing tokens      | Required    |
| `TARIFF_SHIELD_CONTRACT_ID`  | Soroban Contract ID            | Required    |
| `STELLAR_NETWORK_PASSPHRASE` | Soroban network passphrase     | Required    |

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

### Looking up importers (`admin` read commands)

Instead of hand-writing a `SELECT` in `psql`, use the read-only admin commands to find an importer's id or bond id before running another admin command:

```bash
npm run admin -- list-importers                       # id, legal_name, bond_id, stellar_address, email
npm run admin -- list-importers --email demo          # filter by email substring
npm run admin -- get-importer --id <importer-uuid>    # full DB record + on-chain balances (best-effort)
npm run admin -- --help                               # all commands
```

`stellar_secret_encrypted` is never selected or printed. `get-importer` reports on-chain balances when the importer is registered; seeded demo importers use placeholder addresses, so it prints "unavailable" for those.

## Common Issues

For Stellar CLI, wasm32 target, non-default Postgres port (5443), and Redis errors, see [Local development troubleshooting](FAQ.md#local-development-troubleshooting) in the FAQ.

- **Port Conflicts**: If port 3002 or 5432 is already in use, update the respective `.env` or `docker-compose.yml` configuration.
- **Missing Environment Variables**: Ensure your `JWT_SECRET` and Stellar-related variables are correctly populated in `.env`.
- **Docker Startup Failures**: Ensure Docker Desktop is running. Try `docker-compose down` followed by `docker-compose up -d`.

## Stuck on local setup?

If you have followed this guide, [CONTRIBUTING.md](../CONTRIBUTING.md), and [docs/FAQ.md](FAQ.md) and are still blocked by local environment or tooling issues:

1. **Check the FAQ**: Review [docs/FAQ.md](FAQ.md) for quick solutions to the 10 most common setup, database, and dependency errors.
2. **Search existing issues**: Search [GitHub Issues](https://github.com/vjuliaife/TariffShield/issues) to see if another contributor has already encountered and resolved the problem.
3. **Open a setup issue**: If unresolved, open an issue on [GitHub Issues](https://github.com/vjuliaife/TariffShield/issues) titled with `[dev-setup]: <brief summary>`, describing your operating system, tool versions (`node -v`, `cargo --version`, `docker --version`), and the exact terminal command and error output.
4. **Keep production separate**: Note that [docs/runbooks/support-escalation.md](runbooks/support-escalation.md) and [docs/OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) are strictly reserved for production incident response, on-call paging, and surety operational workflows; please do not use production escalation paths for local development questions.
