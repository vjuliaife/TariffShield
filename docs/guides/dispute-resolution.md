# Dispute Resolution

TariffShield gives importers a 72-hour window to formally contest any oracle-set required collateral
increase before it becomes locked-in. This guide explains when a dispute applies, how to raise and
resolve one, and what the contract state looks like at each stage.

---

## When a dispute is available

Every call to `set_required_collateral` (made by the platform admin after an oracle update) opens a
72-hour dispute window on the importer's account. During that window:

- `account.disputeRaised` is `false` and `account.disputeExpiresAt` is set to a future Unix timestamp.
- The importer may call `raiseDispute()` once to flag the new value as contested.

After the 72-hour window expires the dispute option lapses silently — the new value becomes final.

---

## How to raise a dispute

```typescript
import { TariffShieldClient } from '@tariff-shield/sdk';
import { Keypair } from '@stellar/stellar-sdk';

const client = new TariffShieldClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: process.env.CONTRACT_ID!,
  networkPassphrase: 'Test SDF Network ; September 2015',
});

// The importer signs — they are disputing their own required collateral.
const importerKeypair = Keypair.fromSecret(process.env.IMPORTER_SECRET!);
const importerAddress = importerKeypair.publicKey();

async function checkAndDispute() {
  const account = await client.getAccount(importerAddress);

  if (account.disputeRaised) {
    console.log('Dispute already open — awaiting admin resolution.');
    return;
  }

  const windowOpen = account.disputeExpiresAt > 0n;
  if (!windowOpen) {
    console.log('No open dispute window on this account.');
    return;
  }

  const expiresAt = new Date(Number(account.disputeExpiresAt) * 1000);
  console.log(`Dispute window closes: ${expiresAt.toISOString()}`);

  const result = await client.raiseDispute(importerKeypair, importerAddress);
  console.log(`Dispute raised. Tx: ${result.txHash}`);
}

checkAndDispute().catch(console.error);
```

After `raiseDispute` succeeds:
- `account.disputeRaised` becomes `true`.
- `account.preDisputeRequired` is set to the collateral value that was in effect before the oracle update.
- The required collateral stays at the new (disputed) value until the admin resolves it.

---

## How the admin resolves a dispute

The platform admin calls `resolveDispute(signer, importer, accept)`:

| `accept` | Effect |
|---|---|
| `true` | New oracle value is accepted and the dispute is closed. Required collateral stays at the new value. |
| `false` | Dispute is upheld. Required collateral reverts to `preDisputeRequired` (the pre-update value). |

```typescript
// Platform admin resolves the dispute.
const adminKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET!);

async function resolveImporterDispute(accept: boolean) {
  const result = await client.resolveDispute(adminKeypair, importerAddress, accept);
  console.log(`Dispute resolved (accept=${accept}). Tx: ${result.txHash}`);

  const account = await client.getAccount(importerAddress);
  console.log(`Required collateral is now: ${account.requiredCollateral} stroops`);
  console.log(`Dispute raised: ${account.disputeRaised}`);
}

resolveImporterDispute(false).catch(console.error); // false = revert to pre-dispute value
```

---

## Account state at each stage

| Stage | `disputeRaised` | `disputeExpiresAt` | `preDisputeRequired` |
|---|---|---|---|
| No oracle update pending | `false` | `0` | `0` |
| Oracle set new value (window open) | `false` | Future timestamp | `0` |
| Importer called `raiseDispute` | `true` | Future timestamp | Previous required value |
| Admin resolved (`accept=true`) | `false` | `0` | `0` |
| Admin resolved (`accept=false`) | `false` | `0` | `0` |
| Window expired without dispute | `false` | `0` | `0` |

---

## Common mistakes

| Mistake | Result | Fix |
|---|---|---|
| Calling `raiseDispute` after window expires | Contract panics with `Error(Contract, #…)` | Check `disputeExpiresAt > 0` and compare with current ledger time before calling |
| Calling `raiseDispute` twice | Contract panics — dispute already open | Check `!disputeRaised` before calling |
| Admin calls `resolveDispute` when no dispute is open | Contract panics | Read `disputeRaised` first and only call when `true` |
| Importer signs `resolveDispute` instead of admin | Authorization fails | Only the platform admin key can resolve disputes |

---

## Related docs

- [SDK Network Configuration](./sdk-network-config.md)
- [Query Account Status Example](../examples/query-account-status.ts)
- [API Authentication](../api/authentication.md)
