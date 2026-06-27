# TariffShield Operations Runbook

Operational procedures for surety admins and platform operators. Covers the emergency clawback procedure in full; also includes account freeze verification, post-clawback audit steps, and rollback considerations.

---

## Table of Contents

1. [Prerequisites and access](#1-prerequisites-and-access)
2. [Emergency clawback procedure](#2-emergency-clawback-procedure)
3. [Account freeze verification](#3-account-freeze-verification)
4. [Post-clawback audit checklist](#4-post-clawback-audit-checklist)
5. [Dispute window and importer appeals](#5-dispute-window-and-importer-appeals)
6. [Rollback considerations](#6-rollback-considerations)
7. [Escalation contacts](#7-escalation-contacts)

---

## 1. Prerequisites and access

### Required credentials

| Credential | Where stored | Used for |
|---|---|---|
| Surety admin JWT | Issued at `POST /auth/login` | API authentication |
| Surety Stellar keypair | Env var `SURETY_SECRET_KEY` | Signs on-chain transactions |
| Platform admin API key | Env var `PLATFORM_ADMIN_KEY` | Unlocking frozen operations |
| NAIC license number | `surety_license_verifications` table | License check gate on clawback endpoint |

### Pre-flight checks before any clawback

1. Confirm your `surety_license_verifications.status` is `verified`:
   ```
   GET /surety-license/status
   Authorization: Bearer <your-jwt>
   ```
   Expected: `{ "status": "verified", ... }`

2. Confirm the Soroban RPC is reachable:
   ```
   GET /health/ready
   ```
   Expected: `200 OK`

3. Pull live collateral status for the target importer:
   ```
   GET /importers/{importerId}/collateral-status
   Authorization: Bearer <your-jwt>
   ```
   Record `collateralBalance`, `reserveBalance`, and `accountFrozen`.

---

## 2. Emergency clawback procedure

> **Warning:** The `clawback` Soroban entrypoint is **irreversible**. It drains both the collateral and reserve buckets to the surety wallet and sets `account_frozen = true` on-chain. No subsequent deposits, withdrawals, or top-ups are possible on a frozen account.

### When to invoke

Invoke clawback only when **all three** conditions are met:

- [ ] The importer is in default (CBP notice of insufficiency received, or duty payments missed ≥ 30 days past due)
- [ ] Internal credit committee has issued written approval (email or ticketing system record required)
- [ ] Dispute window (configured in contract: default 72 hours) has elapsed since formal notice was sent to the importer

### Step-by-step

**Step 1 — Log the initiating event**

Before calling the API, record in your internal incident system:
- Importer legal name and ID
- Bond ID and current required collateral
- Reason for clawback (paste verbatim from CBP notice or credit committee decision)
- Authorising officer name and timestamp

**Step 2 — Notify the importer**

Send formal notice via the registered email on file. The dispute window starts from this timestamp. If the importer has already been notified and the window has elapsed, proceed.

**Step 3 — Call the clawback endpoint**

```http
POST /importers/{importerId}/clawback
Authorization: Bearer <surety-admin-jwt>
Content-Type: application/json

{
  "reason": "<verbatim legal justification, minimum 20 characters>"
}
```

Expected success response:

```json
{
  "txHash": "abc123...",
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123...",
  "collateralBalance": "0",
  "reserveBalance": "0",
  "accountFrozen": true
}
```

**Step 4 — Verify on-chain state**

Open the `explorerUrl` from the response in a browser and confirm:
- Transaction status: `SUCCESS`
- Operation type: `invoke_host_function`
- The surety wallet received the full collateral + reserve amount

Then call the collateral status endpoint to confirm the on-chain state:

```
GET /importers/{importerId}/collateral-status
```

Expected: `collateralBalance: "0"`, `reserveBalance: "0"`, `accountFrozen: true`

**Step 5 — Download the audit log**

```
GET /compliance/reports
```

A clawback event automatically generates a compliance report entry. Download the PDF for your records and attach it to the incident ticket.

---

## 3. Account freeze verification

If you need to confirm an account is frozen without performing a clawback:

```
GET /importers/{importerId}
```

Look for `accountFrozen: true` in the response. The on-chain source of truth can be independently verified:

```bash
stellar contract invoke \
  --network testnet \
  --id <TARIFF_SHIELD_CONTRACT_ID> \
  -- get_account \
  --importer <importerStellarAddress>
```

The returned `TariffAccount` struct will show `frozen: true`.

---

## 4. Post-clawback audit checklist

Complete all items within 24 hours of the clawback transaction:

- [ ] Stellar Explorer transaction hash recorded in incident ticket
- [ ] `collateralBalance` confirmed `0` via `/importers/{id}/collateral-status`
- [ ] Compliance report PDF downloaded and attached to incident
- [ ] Surety wallet balance reconciled (expected increase = collateral + reserve at time of clawback)
- [ ] Importer account status updated in your bond management system (mark bond as `CALLED`)
- [ ] CBP notified of clawback (email `bond-forfeiture@cbp.dhs.gov` or via ACE portal)
- [ ] Legal hold placed on all importer-related records (do not delete rows)
- [ ] State DOI notified if required by state regulation (check `statesLicensed` on your license record)
- [ ] Internal credit committee notified of completion

---

## 5. Dispute window and importer appeals

The dispute window is set at contract initialization (default: 72 hours). During this window, the importer may call `raise_dispute` on-chain.

If a dispute is raised **before** the clawback is executed:

1. Do **not** proceed with clawback until the dispute is resolved.
2. Call `resolve_dispute` via the contract after internal review:
   - `accepted: true` — dispute upheld; do not claw back; work with importer on repayment plan
   - `accepted: false` — dispute rejected; proceed to clawback following step 3 above

To view open disputes:

```bash
stellar contract invoke \
  --network testnet \
  --id <TARIFF_SHIELD_CONTRACT_ID> \
  -- get_account \
  --importer <importerStellarAddress>
```

Check `dispute_status` in the returned struct (`None`, `Raised`, `Resolved`).

---

## 6. Rollback considerations

> The `clawback` Soroban entrypoint **cannot be undone** at the contract level. There is no `reverse_clawback` entrypoint.

If a clawback was executed in error:

1. **Do not delete** any database records or on-chain data.
2. Contact the platform engineering team immediately (see [Escalation contacts](#7-escalation-contacts)).
3. Remediation options depend on whether the surety wallet has already moved the recovered funds:
   - **Funds still in surety wallet:** The surety can voluntarily return funds to the importer by submitting a manual Stellar payment from the surety keypair to the importer's Stellar address.
   - **Funds already disbursed:** Remediation requires off-chain wire transfer or legal settlement; there is no on-chain path.
4. A new importer registration (`POST /importers`) will be required to resume platform operations for this entity, as the frozen on-chain account cannot be unfrozen.

### Contract upgrade path

If a contract upgrade is required (e.g., to add an `unfreeze` entrypoint for edge cases):

```bash
# Export current state first
npx tsx scripts/backup-state.ts

# Deploy upgraded WASM (requires 2-of-3 admin multi-sig)
stellar contract invoke ... -- propose_upgrade --new_wasm_hash <hash>
# Second admin approves:
stellar contract invoke ... -- approve_upgrade --new_wasm_hash <hash>

# Verify after upgrade
npx tsx scripts/verify-upgrade.ts
```

See `scripts/rollback-upgrade.ts` for emergency rollback to the previous WASM hash.

---

## 7. Escalation contacts

| Role | Contact | When to escalate |
|---|---|---|
| Platform engineering on-call | File a GitHub issue tagged `P0` on [vjuliaife/TariffShield](https://github.com/vjuliaife/TariffShield) | API errors, contract call failures, RPC outages |
| Legal counsel | Per your surety's standard legal escalation path | Any dispute raised by importer; any clawback that may be challenged |
| CBP bond management | ACE portal or `bond-forfeiture@cbp.dhs.gov` | After every clawback, to update bond status with CBP |
| Stellar network status | [dashboard.stellar.org](https://dashboard.stellar.org) | Transactions failing at network level |

---

*Last reviewed: 2026-06-27. Review this runbook whenever the contract is upgraded or the dispute window is changed.*
