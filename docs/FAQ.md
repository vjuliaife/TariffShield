# TariffShield Developer FAQ

> Answers to the 10 most common setup and runtime issues reported by contributors.  
> **Can't find your error?** Search by keyword (⌘F / Ctrl+F) — each entry includes the exact log snippet you'd see.

---

## Quick Links

| Error keyword | Entry |
|---|---|
| `connection refused`, `ECONNREFUSED 5443` | [FAQ 1 — Postgres connection refused](#1-postgres-connection-refused-on-startup) |
| `cannot find .env`, `Missing required env`, `invalid_type` | [FAQ 2 — Missing .env file](#2-missing-env-file-crash-on-startup) |
| `SorobanRpc`, `fetch failed`, `SSL`, `ETIMEDOUT` | [FAQ 3 — Soroban RPC timeout or SSL error](#3-soroban-rpc-timeout-or-ssl-error) |
| `libpq`, `openssl`, `link error`, `pkg-config` | [FAQ 4 — cargo build missing libpq or OpenSSL](#4-cargo-build-failing-due-to-missing-libpq-or-openssl) |
| `XdrDecodingError`, `invalid XDR`, `bad base64` | [FAQ 5 — XDR decoding panic in the Stellar SDK](#5-xdr-decoding-panic-in-the-stellar-sdk) |
| `peer dep`, `ERESOLVE`, `conflicting peer` | [FAQ 6 — npm install peer dependency conflicts](#6-npm-install-peer-dependency-conflicts) |
| `400`, `Bad Request`, Friendbot | [FAQ 7 — Friendbot 400 error on testnet](#7-friendbot-400-error-on-testnet) |
| `NEXT_PUBLIC_`, `undefined` in browser | [FAQ 8 — NEXT_PUBLIC_* vars not visible in browser](#8-next_public_-vars-not-visible-in-the-browser) |
| `jwt expired`, `TokenExpiredError`, `401` | [FAQ 9 — JWT token expired during development](#9-jwt-token-expired-errors-during-development) |
| `port 5432`, `address already in use`, `EADDRINUSE` | [FAQ 10 — docker-compose port conflict on 5432](#10-docker-compose-port-conflict-on-5432) |

---

## 1. Postgres connection refused on startup

**Q:** The API crashes immediately with a connection error even though I just ran `docker-compose up`.

```
Error: connect ECONNREFUSED 127.0.0.1:5443
    at TCPConnectWrap.afterConnect [as oncomplete]
```

**Cause:** The Postgres container hasn't finished its initialization sequence before the API process tries to connect. The healthcheck in `docker-compose.yml` uses `pg_isready` and the container is mapped to host port **5443** (not the default 5432), so host-side tooling must use that port.

**Fix:**

1. Wait for the healthcheck to pass before starting the API:
   ```bash
   make db          # starts only Postgres and waits for healthy status
   make dev         # then start the API
   ```
2. If running manually, poll until ready:
   ```bash
   docker-compose up -d postgres
   until docker-compose exec postgres pg_isready -U tariffshield -d tariffshield; do sleep 1; done
   ```
3. Confirm `DATABASE_URL` in `apps/api/.env` uses port **5443**:
   ```
   DATABASE_URL=postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield
   ```
   See `apps/api/.env.example` for the canonical value.

---

## 2. Missing `.env` file crash on startup

**Q:** The API or web app exits immediately with a validation error about missing environment variables.

```
[env] Missing required env vars:
ZodError: [
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["JWT_SECRET"] }
]
```

**Cause:** The app uses `zod` to validate environment variables at startup (`apps/api/src/config/env.ts`). If `.env` is absent or a required key is missing, it throws before any other code runs.

**Fix:**

```bash
# For the API
cp apps/api/.env.example apps/api/.env

# For the web app
cp apps/web/.env.example apps/web/.env
```

Then fill in the required secrets. At minimum you need `JWT_SECRET` (any 64-hex-char string) and `PLATFORM_STELLAR_SECRET` / `SURETY_STELLAR_SECRET` (generate with `stellar keys generate`). All required variables are documented in `apps/api/.env.example`.

You can also run the automated env setup script:
```bash
make setup-env   # calls scripts/setup-env.ts to scaffold missing values
```

---

## 3. Soroban RPC timeout or SSL error

**Q:** Contract calls hang for 30 seconds then fail, or fail immediately with an SSL error.

```
SorobanRpc.Server error: fetch failed
  cause: ConnectTimeoutError: Connect Timeout Error
```

or

```
Error: unable to verify the first certificate
  code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
```

**Cause (timeout):** The Soroban testnet RPC (`soroban-testnet.stellar.org`) is rate-limited and occasionally degraded. Check its status at [https://status.stellar.org](https://status.stellar.org).

**Cause (SSL):** Corporate VPNs or proxies inject a custom root CA that Node.js doesn't trust by default.

**Fix (timeout):**
```bash
# Retry is built in; if it persists, switch to a community RPC:
STELLAR_RPC_URL=https://soroban-testnet.stellar.org  # default in .env.example
# Alternative: https://rpc-testnet.stellar.org
```

**Fix (SSL):**
```bash
# Point Node.js at your system CA bundle
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt  # Linux
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem                   # macOS
```

For testnet-only development you can also set `NODE_TLS_REJECT_UNAUTHORIZED=0`, but **never in production**.

---

## 4. `cargo build` failing due to missing `libpq` or OpenSSL

**Q:** `cargo build` for the Soroban contract fails with a linker error about missing system libraries.

```
error: failed to run custom build command for `openssl-sys v0.9.x`
  ...
  = note: pkg-config could not find library `openssl`
```

or

```
error[E0463]: can't find crate for `std`
  = note: the `wasm32-unknown-unknown` target may not be installed
```

**Cause:** The contract compiles to `wasm32-unknown-unknown` and requires the Rust WASM target. The `openssl-sys` / `libpq` errors occur when building non-WASM crates in the workspace (e.g., test harnesses) without the system libraries.

**Fix:**

```bash
# Install the WASM target
rustup target add wasm32-unknown-unknown

# macOS: install OpenSSL and libpq via Homebrew
brew install openssl libpq
export PKG_CONFIG_PATH="/opt/homebrew/opt/openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
export PKG_CONFIG_PATH="/opt/homebrew/opt/libpq/lib/pkgconfig:$PKG_CONFIG_PATH"

# Ubuntu / Debian
sudo apt-get install -y libssl-dev pkg-config libpq-dev

# Build only the contract (avoids system library deps)
make build   # runs: cargo build --release --target wasm32-unknown-unknown
```

---

## 5. XDR decoding panic in the Stellar SDK

**Q:** An SDK call throws an XDR decoding error when reading contract state or events.

```
XdrDecodingError: invalid XDR
    at TariffShieldClient.getImporterState
```

or

```
Error: bad base64 encode of length 17
```

**Cause:** The on-chain data was written by a different version of the contract (mismatched XDR schema). This happens when the locally deployed contract ID (`TARIFF_SHIELD_CONTRACT_ID`) doesn't match the contract that actually produced the on-chain data, or when the testnet was reset and old ledger entries are gone.

**Fix:**

1. Verify the contract ID in `apps/api/.env` matches the deployment in `deployments/history.json`.
2. If the testnet was reset, redeploy and update `TARIFF_SHIELD_CONTRACT_ID`:
   ```bash
   make deploy      # deploys and writes to deployments/history.json
   ```
3. If the SDK and contract are out of sync, rebuild the SDK bindings:
   ```bash
   cd packages/sdk && npm run build
   ```

---

## 6. `npm install` peer dependency conflicts

**Q:** Running `npm install` at the repo root fails with peer dependency resolution errors.

```
npm error ERESOLVE unable to resolve dependency tree
npm error  peer dep missing: react@"^18.0.0", required by ...
npm error conflicting peer dependency: react@19.x
```

**Cause:** The web app uses React 19 while some third-party packages still declare a peer dependency on React 18. npm's strict default resolver rejects this.

**Fix:**

```bash
# Option A: use the legacy resolver (recommended for development)
npm install --legacy-peer-deps

# Option B: use npm install at the workspace root (already configured in package.json)
npm install   # the root package.json uses workspaces; run from repo root, not app subdirs

# Option C: install individual workspaces
npm install -w apps/api
npm install -w apps/web
```

The root `package.json` already declares `"overrides"` for known conflicts. If you add a new package that conflicts, add an override there rather than using `--force`.

---

## 7. Friendbot 400 error on testnet

**Q:** Calling Friendbot to fund a new testnet account returns HTTP 400.

```
Error: Friendbot responded with 400
{"detail":"createAccount operation already exists"}
```

or

```
{"detail":"account does not exist"}
```

**Cause:** Friendbot refuses to fund an account that already has a non-zero XLM balance. The "account does not exist" error occurs when you try to call a contract operation on an account that hasn't been funded yet (chicken-and-egg).

**Fix:**

```bash
# Fund a fresh keypair (only works once per account)
stellar keys generate --fund my-test-key --network testnet

# Or via curl (replace G... with your public key)
curl "https://friendbot.stellar.org?addr=GXXXX..."

# If the account already exists, skip Friendbot and send XLM from another funded account
stellar tx new payment --destination GXXXX --asset XLM --amount 100 \
  --source-account <funded-secret> --network testnet --sign --submit
```

The Makefile `make setup-env` funds the platform and surety keypairs automatically if they have zero balance.

---

## 8. `NEXT_PUBLIC_*` vars not visible in the browser

**Q:** Environment variables prefixed `NEXT_PUBLIC_` are `undefined` at runtime in the browser, even though they are set in `apps/web/.env`.

```js
// In browser console:
console.log(process.env.NEXT_PUBLIC_API_URL) // undefined
```

**Cause:** Next.js inlines `NEXT_PUBLIC_*` variables at **build time**, not at runtime. If the `.env` file is added or changed after `next build`, the old baked-in values (or `undefined`) are still in the bundle.

**Fix:**

```bash
# After changing apps/web/.env, rebuild the web app
cd apps/web
npm run build   # re-inlines env vars into the JS bundle
npm run start   # or: npm run dev (dev server re-reads on restart)
```

In development (`npm run dev`), the dev server watches `.env` changes but requires a **restart** — not just a hot-reload — to pick up new `NEXT_PUBLIC_*` values.

The canonical variables are documented in `apps/web/.env.example`:
```
NEXT_PUBLIC_API_URL=http://localhost:3002
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_CONTRACT_ID=...
```

---

## 9. JWT token expired errors during development

**Q:** API calls return 401 after working fine earlier in the day.

```json
{"error": "Unauthorized", "detail": "jwt expired"}
```

```
JsonWebTokenError: TokenExpiredError: jwt expired
    at /verify (/apps/api/src/auth.ts)
```

**Cause:** JWTs issued by the API have a 24-hour expiry (`expiresIn: '24h'` in `apps/api/src/routes/auth.ts`). Development sessions that span multiple days will hit this without clearing browser storage.

**Fix:**

```bash
# Re-authenticate: POST /auth/login with your dev credentials
curl -X POST http://localhost:3002/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"devpassword"}'
# Copy the returned token into Authorization: Bearer <token>
```

In the browser, open DevTools → Application → Local Storage → clear `tariffshield_token`, then log in again. The web app's auth hook (`apps/web/lib/auth.ts`) detects the 401 and redirects to `/login` automatically.

To avoid this during long development sessions, set a longer expiry in `.env`:
```
JWT_EXPIRES_IN=7d
```

---

## 10. `docker-compose` port conflict on 5432

**Q:** `docker-compose up` fails because port 5432 is already in use.

```
Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:5432 -> 0.0.0.0:0: listen tcp4 0.0.0.0:5432: bind: address already in use
```

**Cause:** A local PostgreSQL instance (installed via `brew`, `apt`, or system package manager) is already listening on port 5432. The TariffShield `docker-compose.yml` maps the container's 5432 to host port **5443** by default to avoid this, but if you've edited the mapping to `5432:5432`, the conflict reappears.

**Fix:**

```bash
# Option A: use the default mapping (5443:5432) — already set in docker-compose.yml
# No change needed; connect via localhost:5443

# Option B: stop the local Postgres service
sudo systemctl stop postgresql   # Linux
brew services stop postgresql@16  # macOS

# Option C: change the host port to any free port
# In docker-compose.yml:
#   ports:
#     - "5444:5432"   # or any other free port
# Then update DATABASE_URL in apps/api/.env accordingly
```

---

## Contributing to this FAQ

If you resolved a setup issue not covered here:

1. Add a new numbered entry following the template:
   ```
   ## N. Short symptom title
   **Q:** What the developer sees / asks.
   ```<language>
   exact error message or log snippet
   ```
   **Cause:** Root cause explanation.
   **Fix:** Step-by-step resolution with exact commands.
   ```
2. Add a row to the **Quick Links** table at the top with the most searchable error keyword.
3. Open a PR with `docs:` prefix in the title, e.g. `docs: add FAQ entry for X`.

The goal is that a contributor can Ctrl+F their exact error message and land directly on a working fix.
