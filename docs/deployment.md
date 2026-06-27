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
