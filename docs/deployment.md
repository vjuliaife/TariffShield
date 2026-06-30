# Deployment

## Vercel preview deployments

Every pull request automatically deploys to a Vercel preview environment. The preview URL is
posted as a PR comment by the `Vercel Preview / deploy` workflow job.

### Required GitHub Actions secrets

Add these in **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Description |
|--------|-------------|
| `VERCEL_TOKEN` | Personal access token from Vercel → Settings → Tokens |
| `VERCEL_ORG_ID` | Found in Vercel project settings or via `vercel whoami` |
| `VERCEL_PROJECT_ID` | Found in Vercel project settings or `.vercel/project.json` after `vercel link` |

### Required GitHub Actions variables

Add these in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Description |
|----------|-------------|
| `STAGING_API_URL` | Base URL of the staging API, e.g. `https://api-staging.tariffshield.example` |

### Connecting the Vercel project

1. Install the Vercel CLI: `npm i -g vercel`
2. From the repo root run `vercel link` and follow the prompts
3. In the Vercel project settings set **Root Directory** to `apps/web`
4. Set the following environment variables per tier in the Vercel dashboard:

| Variable | development | preview | production |
|----------|------------|---------|------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3002` | `$STAGING_API_URL` | `https://api.tariffshield.example` |
| `NEXT_PUBLIC_STELLAR_NETWORK` | `testnet` | `testnet` | `mainnet` |
| `NEXT_PUBLIC_CONTRACT_ID` | local contract | staging contract | production contract |

### Preview deployment lifecycle

- A new preview URL is created on every push to a PR branch.
- When a PR is closed or merged, Vercel automatically marks the deployment as superseded.
- The `Vercel Preview / deploy` status check must pass before a PR can merge (enforced by branch
  protection).

## Production deployment

Production deploys are triggered by merges to `main`. Vercel automatically builds and deploys from
the `main` branch using the production environment variable set.

## Rollback

See `docs/OPERATIONS_RUNBOOK.md` for contract rollback procedures. For the web app, redeploy any
prior Vercel deployment from the Vercel dashboard (Deployments → select build → Redeploy).

## API Deployment (Render)

This section explains how to deploy the TariffShield API to Render.

### Render Deploy Hook Setup

1. In the Render Dashboard, navigate to your Web Service (API).
2. Go to **Settings** and scroll down to the **Deploy Hook** section.
3. Copy the URL.

### GitHub Secrets Configuration

Add the following secrets to your GitHub repository:
- `RENDER_DEPLOY_HOOK_URL`: The URL copied from Render.
- `RENDER_SERVICE_ID`: The ID of your Render service.

### Deployment Workflow

The `.github/workflows/deploy-api.yml` action automates deployment:
- Pushes to the `main` branch trigger the workflow.
- The workflow invokes the Render Deploy Hook.
- It then polls the `/health` endpoint to verify the deployment was successful and that PostgreSQL is connected.
- Finally, it reports the deployed commit SHA.

### Rollback Preparation

If a deployment introduces issues, you can rollback from the Render dashboard:
1. Navigate to the **Events** tab of your Render service.
2. Locate the previous successful deploy.
3. Click **Deploy this commit** to rollback to that version.

### Operational Notes

- Ensure all environment variables match `.env.example` in production.
- Monitor the `/health` endpoint for database connectivity.

## Staging Environment

A dedicated staging tier (`tariffshield-api-staging` on Render and a staging environment on Vercel) isolates pre-production validation, Playwright E2E testing, and manual QA.

### Setup & Architecture

- **Database**: A separate PostgreSQL instance (e.g., Render Managed or Neon free tier) is used.
- **Network**: Stellar `testnet` is used.
- **Git Branch**: Connected to the `main` branch.
- **Workflow**: Merges to `main` trigger `.github/workflows/deploy-staging.yml` first. The production deployment workflow (`.github/workflows/deploy-api.yml`) is gated on the success of the staging deployment via `workflow_run`.

### GitHub Environment Configuration

Create a GitHub Actions Environment named `staging` in **Settings → Environments**. Add the following Secrets to the environment:

| Secret | Description |
|---|---|
| `STAGING_DATABASE_URL` | Connection string for the staging PostgreSQL database. |
| `STAGING_RENDER_DEPLOY_HOOK_URL` | Deploy hook URL for `tariffshield-api-staging` on Render. |
| `STAGING_STELLAR_SECRET_KEY` | Secret key (`S...`) of the dedicated staging platform admin keypair. |
| `STAGING_CONTRACT_ID` | Contract ID of the TariffShield contract deployed on Testnet for staging. |
| `VERCEL_TOKEN` | Vercel Personal Access Token (can also be repository-wide). |
| `VERCEL_ORG_ID` | Vercel Organization ID (can also be repository-wide). |
| `VERCEL_PROJECT_ID` | Vercel Project ID (can also be repository-wide). |

### Deploying the Soroban Contract to Testnet

To deploy or re-deploy the TariffShield contract to Stellar Testnet for staging:

1. **Generate and Fund Staging Admin Keypair**:
   Generate a keypair locally (or use the one stored in `STAGING_STELLAR_SECRET_KEY`):
   ```bash
   stellar keys generate --fund staging-admin --network testnet
   ```
   *Note: Friendbot will automatically fund this account with 10,000 testnet XLM.*

2. **Build and Optimize the Contract**:
   Navigate to the repository root and build/optimize the Rust contract:
   ```bash
   # Build the release WASM
   npm run build
   cd contracts && cargo build --release --target wasm32-unknown-unknown
   
   # Optimize the WASM binary
   stellar contract optimize --wasm target/wasm32-unknown-unknown/release/tariff_shield.wasm
   ```

3. **Deploy the Contract**:
   Deploy the optimized WASM to Testnet:
   ```bash
   stellar contract deploy \
     --network testnet \
     --source staging-admin \
     --wasm target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm
   ```
   This command will output the new contract ID (e.g., `CBLAS...`). Save this as `STAGING_CONTRACT_ID` in your GitHub environment secrets.

4. **Initialize the Contract State**:
   Invoke the `initialize` function on the newly deployed contract:
   ```bash
   stellar contract invoke \
     --id <STAGING_CONTRACT_ID> \
     --network testnet \
     --source staging-admin \
     -- \
     initialize \
     --admins '["<STAGING_ADMIN_PUBLIC_KEY>"]' \
     --surety "<STAGING_SURETY_PUBLIC_KEY>" \
     --token "<TESTNET_USDC_TOKEN_CONTRACT_ID>" \
     --oracle_admin "<STAGING_ORACLE_ADMIN_PUBLIC_KEY>" \
     --emergency_oracle_admin "<STAGING_EMERGENCY_ORACLE_ADMIN_PUBLIC_KEY>"
   ```

## Container Registry (GHCR)

Every merge to `main` automatically builds the Express API and pushes a Docker image to GitHub Container Registry.

### Image URL format

```
ghcr.io/<owner>/tariffshield-api:latest
ghcr.io/<owner>/tariffshield-api:<short-sha>
```

Where `<owner>` is the GitHub organisation or user that owns the repository (lower-cased) and `<short-sha>` is the first 7 characters of the merge commit SHA.

### Pulling on Render instead of building from source

1. In the Render service settings, switch **Deploy** from **Git** to **Docker image**.
2. Set the image URL to `ghcr.io/<owner>/tariffshield-api:latest`.
3. Because the image is public on GHCR, Render can pull it without additional credentials.
4. On every merge, the `.github/workflows/docker-publish.yml` workflow pushes a new `latest` tag. Trigger a Render redeploy manually or connect a Render deploy hook to the workflow.

### Rolling back to a previous image

Each push also tags the image with the short commit SHA. To roll back:

```bash
# In Render dashboard → Settings → Docker Image, set the image to the previous SHA tag:
ghcr.io/<owner>/tariffshield-api:<previous-sha>
```

Or redeploy from the Render **Events** tab as described in the rollback section above.

