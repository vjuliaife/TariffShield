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
