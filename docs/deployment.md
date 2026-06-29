# Deployment Guide

This document provides a comprehensive step-by-step deployment guide for all components of the TariffShield system:
1. The **Soroban Smart Contract** on the Stellar network.
2. The **Express API** on Render.
3. The **Next.js Web Dashboard** on Vercel.

---

## 1. Prerequisites

Ensure you have the following tools installed with at least the specified minimum versions:

| Tool | Minimum Version | Purpose |
|------|-----------------|---------|
| **Node.js** | `v20.0.0` | Runtime for API and Frontend development/deployment |
| **Rust** | `v1.94.0` | Rust compiler targeting `wasm32-unknown-unknown` |
| **Stellar CLI** | `v25.2.0` | CLI to build, optimize, and deploy Soroban contracts |
| **Docker** | `v24.0.0` | Containerization engine for running Postgres and API |
| **Vercel CLI** | `v32.0.0` | Deployment tool for Next.js web dashboard |
| **Render CLI / Account** | N/A | Platform for hosting the Express API |

---

## 2. Environment Variables Reference

### API Service — `apps/api/.env`

These environment variables are validated at startup via Zod in [env.ts](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/apps/api/src/config/env.ts).

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `PORT` | No (default: `3002`) | Port the Express API server listens on | `3002` |
| `NODE_ENV` | No (default: `development`) | Runtime environment: `development`, `production`, `test` | `production` |
| `DATABASE_URL` | **Yes** | Connection string for PostgreSQL database | `postgres://user:pass@host:5432/db?sslmode=require` |
| `FRONTEND_ORIGIN` | No (default: `http://localhost:3000`) | CORS allowed origin for client browsers | `https://tariffshield.vercel.app` |
| `JWT_SECRET` | **Yes** | 32+ character HMAC key for signing JWT tokens | `super-secret-jwt-key-at-least-32-chars-long` |
| `STELLAR_NETWORK` | No (default: `testnet`) | Network to target: `testnet` or `public` | `testnet` |
| `STELLAR_RPC_URL` | **Yes** | URL of the Soroban RPC server | `https://soroban-testnet.stellar.org` |
| `STELLAR_HORIZON_URL` | **Yes** | URL of the Stellar Horizon REST API | `https://horizon-testnet.stellar.org` |
| `STELLAR_NETWORK_PASSPHRASE` | **Yes** | Stellar network passphrase matching network | `Test SDF Network ; September 2015` |
| `TARIFF_SHIELD_CONTRACT_ID` | **Yes** | Deployed Soroban contract address | `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF` |
| `PLATFORM_STELLAR_SECRET` | **Yes** | Secret seed for the platform admin Stellar account | `SDAAAAA...` |
| `SURETY_STELLAR_SECRET` | **Yes** | Secret seed for the surety admin Stellar account | `SBBBBB...` |
| `PRICE_ORACLE_CONTRACT_ID`| No | Contract address of the USDC/USD price oracle | `CCDDDD...` |
| `EMERGENCY_ADMIN_SECRET` | No | Secret seed for the emergency oracle admin account | `SEEEEE...` |
| `FIELD_ENCRYPTION_KEY`   | No | AES-256-GCM encryption key for PII fields | `32-character-encryption-key-here!` |

### Web Service — `apps/web/.env.local`

| Variable | Required | Description | Example Value |
|----------|----------|-------------|---------------|
| `NEXT_PUBLIC_API_URL` | **Yes** | API URL accessible from the client browser | `https://tariffshield-api.onrender.com` |
| `NEXT_PUBLIC_STELLAR_NETWORK` | No | Stellar network type | `testnet` |
| `NEXT_PUBLIC_CONTRACT_ID` | **Yes** | Soroban contract ID | `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF` |

---

## 3. Soroban Smart Contract Deployment

Deploying the contract involves compiling it to WebAssembly, optimizing the bytecode size, and registering it on the Stellar network.

### Commands

1. **Build the WASM binary**:
   Run the following from the root directory:
   ```bash
   cargo build --target wasm32-unknown-unknown --release
   ```
2. **Optimize the WASM binary**:
   Use the Stellar CLI to reduce code size (crucial for Soroban resource limits):
   ```bash
   stellar contract optimize --wasm target/wasm32-unknown-unknown/release/tariff_shield.wasm
   ```
3. **Deploy the contract**:
   * **Testnet**:
     ```bash
     stellar contract deploy --network testnet --source-account <admin-secret-or-alias> --wasm target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm
     ```
   * **Mainnet**:
     ```bash
     stellar contract deploy --network pubnet --source-account <admin-secret-or-alias> --wasm target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm
     ```
4. **Initialize the contract**:
   Invoke the one-shot `initialize` method:
   ```bash
   stellar contract invoke --id <deployed-contract-id> --network testnet --source-account <admin-secret-or-alias> -- initialize --admins '["<admin-address>"]' --surety "<surety-address>" --token "<token-address>" --oracle_admin "<oracle-admin-address>" --emergency_oracle_admin "<emergency-oracle-admin-address>"
   ```

---

## 4. Express API Deployment on Render

The Express API is containerized and deploys to Render Web Services.

### Service Configuration (`render.yaml`)

Since TariffShield is a monorepo, a Web Service is defined pointing to the API directory:

```yaml
services:
  - type: web
    name: tariffshield-api
    env: docker
    dockerContext: .
    dockerfilePath: apps/api/Dockerfile
    plan: starter
    envVars:
      - key: PORT
        value: 3002
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false
      - key: JWT_SECRET
        sync: false
      - key: STELLAR_RPC_URL
        value: https://soroban-testnet.stellar.org
      - key: STELLAR_HORIZON_URL
        value: https://horizon-testnet.stellar.org
      - key: STELLAR_NETWORK_PASSPHRASE
        value: "Test SDF Network ; September 2015"
      - key: TARIFF_SHIELD_CONTRACT_ID
        sync: false
      - key: PLATFORM_STELLAR_SECRET
        sync: false
      - key: SURETY_STELLAR_SECRET
        sync: false
```

### Steps to Deploy via Render Dashboard

1. Create a new **Web Service** on Render and connect your repository.
2. Select **Docker** as the environment.
3. Under **Advanced**, set the **Docker Build Context** to the repository root (`.`) and **Dockerfile Path** to `apps/api/Dockerfile`.
4. Go to the **Environment** tab and add all required environment secrets (e.g., `DATABASE_URL`, `JWT_SECRET`, `PLATFORM_STELLAR_SECRET`, etc.).
5. Click **Manual Deploy** -> **Deploy latest commit** to trigger the build.

---

## 5. Next.js Web App Deployment on Vercel

The Next.js dashboard is optimized for Vercel's edge hosting environment.

### Steps to Deploy via Vercel CLI

1. Install the Vercel CLI and log in:
   ```bash
   npm i -g vercel
   vercel login
   ```
2. Navigate to the repo root and link your project:
   ```bash
   vercel link
   ```
3. Set the **Root Directory** settings to `apps/web` in the Vercel dashboard.
4. Add the required public environment variables on the dashboard:
   - `NEXT_PUBLIC_API_URL`
   - `NEXT_PUBLIC_CONTRACT_ID`
   - `NEXT_PUBLIC_STELLAR_NETWORK`
5. Run the production deployment:
   ```bash
   vercel --prod
   ```

---

## 6. Post-Deploy Verification (Smoke Tests)

To verify the deployment is working correctly, perform these three smoke tests:

1. **Verify API Health Endpoint**:
   Perform a `GET` request to verify the server is running and connected to PostgreSQL:
   ```bash
   curl -I https://<your-render-url>/health
   ```
   *Expected response*: `HTTP/1.1 200 OK`
2. **Verify API & Database Write Flow**:
   Create a new user account:
   ```bash
   curl -X POST https://<your-render-url>/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email": "admin@example.com", "password": "securepassword123", "role": "surety_admin"}'
   ```
   *Expected response*: A JSON containing the authenticated JWT token and user info.
3. **Verify On-Chain Connectivity**:
   Ensure you can query the contract using the Stellar CLI:
   ```bash
   stellar contract invoke --id <contract-id> --network testnet --source-account <admin-secret-or-alias> -- get_account --importer "<importer-stellar-address>"
   ```
   *Expected response*: The contract should return the empty importer structural representation or a descriptive error if unregistered.

---

## 7. Rollback Procedures

### Web Application (Vercel)
To revert to a prior web release, go to the **Deployments** tab on the Vercel dashboard, locate the stable release, and click **Redeploy**.

### Express API (Render)
To rollback the API, navigate to the Render service dashboard, click **Rollback** under the deployment logs page, and select the target stable commit.

### Soroban Smart Contract Upgrades
If a faulty WASM is deployed, do not attempt to delete the contract. Instead, invoke the multi-sig upgrade pattern defined in [lib.rs](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/contracts/tariff-shield/src/lib.rs):
1. Propose the new WASM hash:
   ```bash
   stellar contract invoke --id <contract-id> --network testnet --source-account <admin-secret-or-alias> -- propose_upgrade --caller "<admin-address>" --new_wasm_hash "<new-wasm-hash>"
   ```
2. Approve and upgrade the contract using the multi-sig approval pattern.
