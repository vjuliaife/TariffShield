# Support Escalation Runbook

TariffShield processes financial transactions on the Stellar network and stores compliance-critical importer data in PostgreSQL. This runbook guides support staff through the four most common incident types, defines escalation paths, and lists safe diagnostic commands.

**See also:** [`docs/OPERATIONS_RUNBOOK.md`](../OPERATIONS_RUNBOOK.md) for emergency clawback and contract upgrade procedures.

---

## Severity Classification

| Severity | Condition | Owner | Response SLA |
|----------|-----------|-------|-------------|
| **P0** | Bond collateral at risk — CBP deadline missed, clawback in flight, or on-chain freeze detected | Contract Admin + Legal | Immediate |
| **P1** | Importer locked out (cannot authenticate) or deposit transaction pending > 30 minutes | L2 Engineering On-Call | 30 minutes |
| **P2** | Data display discrepancy — UI balance differs from on-chain state, auto top-up not firing | L2 Engineering | 2 hours |
| **P3** | General inquiry — how-to questions, KYC status checks, non-urgent configuration | L1 Support | Next business day |

---

## Incident 1: Failed Deposit Transaction

**Symptoms:** Importer reports a deposit that did not appear in the UI or their balance did not increase after a transaction was submitted.

### Diagnosis

1. Obtain the importer UUID from the support ticket or by querying:
   ```sql
   SELECT i.id, i.stellar_address, u.email
   FROM importers i
   JOIN users u ON u.id = i.user_id
   WHERE u.email = '<reporter-email>';
   ```

2. Find recent transaction hashes for the importer:
   ```sql
   SELECT id, kind, amount, tx_hash, created_at
   FROM contract_events
   WHERE importer_id = '<importer-id>'
   ORDER BY created_at DESC
   LIMIT 10;
   ```

3. Check finality on Stellar Expert (testnet):
   ```
   https://stellar.expert/explorer/testnet/tx/<TX_HASH>
   ```
   For mainnet, replace `testnet` with `public`.

4. Verify current on-chain balance via the API:
   ```bash
   curl -s -H "Authorization: Bearer <ADMIN_JWT>" \
     https://<API_HOST>/api/v1/importers/<IMPORTER_ID> | jq '.onChainAccount'
   ```

### Resolution

| On-chain state | DB state | Action |
|----------------|----------|--------|
| Confirmed | Missing event | Insert a `deposit_collateral` event row referencing the on-chain tx hash; do **not** manually adjust balance columns |
| Failed / not found | No event | Advise importer to retry via `POST /api/v1/importers/:id/deposit`; no DB action needed |
| Pending (in-flight) | No event | Wait up to 5 minutes; Stellar transactions either confirm or fail within ~5 ledger closes (~25 seconds each) |

> **Escalate to P0** if collateral has been seized on-chain but the database shows a healthy balance.

---

## Incident 2: Auto Top-Up Not Triggering

**Symptoms:** Importer's collateral balance dropped below the required threshold but no automatic top-up transaction was submitted.

### Diagnosis

1. Check current balances via the API:
   ```bash
   curl -s -H "Authorization: Bearer <ADMIN_JWT>" \
     https://<API_HOST>/api/v1/importers/<IMPORTER_ID> | jq '.onChainAccount | {collateralBalance, requiredCollateral, reserveBalance}'
   ```

2. Confirm whether a shortfall actually exists:
   - If `collateralBalance >= requiredCollateral`: no top-up is needed; the alert may be stale. Resolve as P3.

3. Verify the auto-top-up background job is running — check application logs for recent activity:
   ```
   grep "\[auto-top-up\]" /var/log/api/app.log | tail -20
   ```
   On Render: check the **Logs** tab in the API service dashboard.

4. Check whether `reserveBalance` is zero:
   - If zero, the importer has not funded their reserve bucket. The auto-top-up job cannot move funds that do not exist.

### Resolution

- **If reserve is funded and job appears healthy:** manually invoke the top-up via the API:
  ```bash
  curl -s -X POST \
    -H "Authorization: Bearer <PLATFORM_ADMIN_JWT>" \
    https://<API_HOST>/api/v1/importers/<IMPORTER_ID>/auto-top-up
  ```

- **If reserve is zero:** notify the importer they must deposit to the `reserve` bucket via `POST /api/v1/importers/:id/deposit` with `"bucket": "reserve"`.

- **If the job is stalled or crashed:** escalate to L2 Engineering On-Call (P1); the background job process needs to be restarted on Render.

---

## Incident 3: Importer Locked Out / JWT Issues

**Symptoms:** Importer receives HTTP 403 "account temporarily locked" or cannot log in despite correct credentials.

### Diagnosis

1. Check the account status in the database:
   ```sql
   SELECT id, email, locked_until, role
   FROM users
   WHERE email = '<reporter-email>';
   ```

2. Determine the lock cause:
   - `locked_until IS NOT NULL AND locked_until > NOW()`: active time-based lock from too many failed attempts (10 consecutive failures within 30 minutes trigger a 30-minute lock).
   - `locked_until IS NULL`: account is not locked; the issue may be an incorrect password or a revoked/expired JWT.

3. Count recent failed attempts:
   ```sql
   SELECT COUNT(*) AS failed_count, MAX(created_at) AS last_attempt
   FROM authentication_attempts
   WHERE email = '<reporter-email>'
     AND success = false
     AND created_at > NOW() - INTERVAL '30 minutes';
   ```
   If `failed_count` is still high, the account may be under an active brute-force attack — **do not unlock**.

### Resolution

- **Lock is expired (locked_until < NOW()):** the lock clears automatically on the next login attempt. No manual action is needed; advise the importer to wait and retry.

- **Lock is active and failed_count is low (< 3 in the last 30 min):** this may be a legitimate lockout. Clear the lock only after verifying the importer's identity through a secondary channel:
  ```sql
  -- Only run after identity verification and after confirming no active attack
  UPDATE users SET locked_until = NULL WHERE email = '<reporter-email>';
  ```

- **JWT is valid but rejected (401):** the signing secret may have rotated. Advise the importer to log in again to obtain a fresh token.

- **To re-issue credentials:** use the platform admin signup flow or a dedicated password-reset API if available. Never read or share the `password_hash` column.

> **Escalate to L2** if `failed_count` is high (active brute-force) or if the account shows signs of unauthorized access.

---

## Incident 4: Balance Discrepancy Between UI and Chain

**Symptoms:** The UI displays a collateral balance that differs from the actual on-chain state.

### Diagnosis

1. Fetch the API's view (which reads live from the contract):
   ```bash
   curl -s -H "Authorization: Bearer <ADMIN_JWT>" \
     https://<API_HOST>/api/v1/importers/<IMPORTER_ID> | jq '.onChainAccount'
   ```

2. Query the on-chain state directly via the Stellar CLI (the contract exposes `get_account`, not `get_bond_state`):
   ```bash
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --source <READ_ONLY_ADMIN_KEY> \
     --network testnet \
     -- get_account \
     --importer <STELLAR_ADDRESS>
   ```
   Replace `testnet` with `mainnet` (or the appropriate network alias) for production.

3. Compare `collateralBalance` from step 1 vs. step 2. If they differ, the API's live read is the authoritative value.

4. Check the database event log to see if an event was recorded without a corresponding on-chain state update:
   ```sql
   SELECT kind, amount, tx_hash, created_at
   FROM contract_events
   WHERE importer_id = '<importer-id>'
   ORDER BY created_at DESC
   LIMIT 20;
   ```

5. Refer to [`monitoring/runbooks/balance-drift.md`](../../monitoring/runbooks/balance-drift.md) for threshold definitions and the automated alert conditions.

### Resolution

- **API live-read matches on-chain but UI shows different value:** this is a frontend caching issue. Advise the importer to hard-refresh the page. If persistent, escalate to L2.

- **DB event log is inconsistent with on-chain:** insert a corrective `contract_events` row that reflects the true on-chain state. Update any cached balance columns in the `importers` table to match the contract. Never invent on-chain transactions.

- **On-chain state is unexpectedly different from all DB records:** escalate to P0 — this may indicate an unauthorized contract invocation or a missed clawback.

---

## Escalation Matrix

| Severity | First Responder | Escalation Path | SLA |
|----------|----------------|-----------------|-----|
| P0 | L2 Engineering On-Call | → Contract Admin → Legal within 15 min | Immediate |
| P1 | L2 Engineering On-Call | → Contract Admin if not resolved in 1 hour | 30 min |
| P2 | L1 Support | → L2 Engineering if not resolved in 4 hours | 2 hours |
| P3 | L1 Support | → L2 Engineering if blocked | Next business day |

Contacts and PagerDuty rotation are maintained in the internal team directory (not stored in this repository).

---

## Useful Commands Appendix

### Stellar CLI — read-only contract queries

```bash
# Get full on-chain account state for an importer
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <READ_ONLY_ADMIN_KEY> \
  --network testnet \
  -- get_account \
  --importer <STELLAR_ADDRESS>

# Check collateral staleness (returns true if last update > 365 days ago)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <READ_ONLY_ADMIN_KEY> \
  --network testnet \
  -- is_collateral_stale \
  --importer <STELLAR_ADDRESS>

# Get rolling collateral history (last 12 entries)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <READ_ONLY_ADMIN_KEY> \
  --network testnet \
  -- get_collateral_history \
  --importer <STELLAR_ADDRESS>
```

### psql — importer record checks

```sql
-- Look up importer by user email
SELECT i.id, i.legal_name, i.stellar_address, i.bond_id, i.registered_on_chain_tx, i.kyc_status
FROM importers i JOIN users u ON u.id = i.user_id
WHERE u.email = '<email>';

-- Last 20 contract events for an importer
SELECT kind, amount, tx_hash, created_at
FROM contract_events
WHERE importer_id = '<uuid>'
ORDER BY created_at DESC
LIMIT 20;

-- Check for tariff uploads and computed collateral
SELECT filename, annual_duty_total, computed_required_collateral, applied_tx, created_at
FROM tariff_uploads
WHERE importer_id = '<uuid>'
ORDER BY created_at DESC
LIMIT 5;

-- Recent failed authentication attempts
SELECT email, success, ip_address, created_at
FROM authentication_attempts
WHERE email = '<email>'
ORDER BY created_at DESC
LIMIT 10;
```

### API health checks via curl

```bash
# Health check (no auth required)
curl -s https://<API_HOST>/health

# Verify authenticated access with a token
curl -s -H "Authorization: Bearer <JWT>" \
  https://<API_HOST>/api/v1/auth/me

# Get all importers (surety admin token required)
curl -s -H "Authorization: Bearer <ADMIN_JWT>" \
  https://<API_HOST>/api/v1/importers | jq '.importers | length'
```

---

## Never Do This

The following actions are **prohibited** and may cause irreversible data loss, regulatory violations, or security incidents:

- **Never write directly to the `contract_events` or `transactions` tables** to "fix" a balance discrepancy. The on-chain Soroban contract is the source of truth; the database is a cache. Only append reconciliation events after reading the true on-chain state.

- **Never share `stellar_secret_encrypted` values** (or any column containing key material) in support tickets, Slack messages, or email.

- **Never force-unlock an account** (`UPDATE users SET locked_until = NULL`) while a brute-force attack is in progress (high `failed_count` in the last 30 minutes). Check the attempt count first.

- **Never invoke the clawback endpoint** (`POST /api/v1/importers/:id/clawback`) as a diagnostic or "reset" step. Clawback is irreversible on-chain and constitutes a legal enforcement action. Follow the full procedure in `docs/OPERATIONS_RUNBOOK.md`.

- **Never directly invoke write functions on the Soroban contract** (e.g., `deposit_collateral`, `set_required_collateral`) from the command line without explicit authorization from the Contract Admin and a written incident record.
