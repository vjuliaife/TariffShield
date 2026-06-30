# TariffShield SDK

The official TypeScript SDK for interacting with the TariffShield Soroban smart contract.

## Installation

```bash
npm install @tariffshield/sdk
```

### Peer Dependencies

The SDK requires `stellar-sdk` as a peer dependency:

```bash
npm install stellar-sdk
```

## Configuration

Initialize the client with your network details:

```typescript
import { TariffShieldClient } from "@tariffshield/sdk";

const client = new TariffShieldClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF",
  networkPassphrase: "Test SDF Network ; September 2015",
});
```

## API Reference

### Read Methods

#### `getAccount(importerAddress: string)`
Returns the on-chain state for a specific importer.

- **Parameters**: `importerAddress` (Stellar public key)
- **Returns**: `Promise<Account>`

### Write Methods

Write methods require a signing `Keypair` and return the transaction hash along with any decoded result.

#### `autoTopUp(signer: Keypair, importerAddress: string)`
Permissionlessly moves funds from the reserve to the collateral balance if the importer is under-collateralized.

- **Parameters**: 
  - `signer`: Any valid Stellar Keypair
  - `importerAddress`: Target importer public key
- **Returns**: `Promise<{ txHash: string, movedStroops: string }>`

#### `clawback(suretySigner: Keypair, importerAddress: string)`
Surety admin action to seize collateral and reserve funds, freezing the account.

- **Parameters**:
  - `suretySigner`: The authorized surety Keypair
  - `importerAddress`: Target importer public key
- **Returns**: `Promise<{ txHash: string, clawedStroops: string }>`

*(See source for full list of methods including `initialize`, `registerImporter`, `depositCollateral`, `depositReserve`, `setRequiredCollateral`, `withdrawCollateral`, `accrueYield`)*

## Types

```typescript
export interface Account {
  bond_id: number;
  collateral_balance: string;
  required_collateral: string;
  reserve_balance: string;
  yield_accrued: string;
  is_clawbacked: boolean;
}
```

## Error Handling

Contract errors are mapped to specific enums (e.g., `Error::AccountFrozen = 7`). The SDK propagates Soroban RPC errors if a transaction fails simulation or is rejected during submission.

## End-to-End Importer Workflow Example

```typescript
import { Keypair } from "stellar-sdk";

// 1. Initialize client
const client = new TariffShieldClient({ ... });

// 2. Setup keys
const admin = Keypair.fromSecret("S_ADMIN_SECRET...");
const importer = Keypair.fromSecret("S_IMPORTER_SECRET...");

// 3. Register importer
await client.registerImporter(admin, importer.publicKey(), 1001, "500000000");

// 4. Deposit reserve
await client.depositReserve(importer, importer.publicKey(), "1000000000");

// 5. Trigger auto top-up
const result = await client.autoTopUp(admin, importer.publicKey());
console.log(`Moved ${result.movedStroops} stroops to collateral in tx ${result.txHash}`);
```

## Smoke Test

You can verify the SDK is configured correctly by running the read-only smoke test script:
```bash
npx tsx scripts/sdk-smoke.ts
```
