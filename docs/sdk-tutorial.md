# TariffShield SDK Usage Tutorial: The Importer Lifecycle

This tutorial provides a narrative walk-through of the TariffShield SDK. You will learn how to use the SDK to complete a real business flow: from registering an importer to depositing collateral and reserves, simulating a tariff spike, triggering an auto-top-up, and accruing yield.

---

## Prerequisites

Before starting, ensure you have the following configured and running:
1. **Node.js**: Version 20 or higher.
2. **Stellar Testnet Account**: A funded Stellar Testnet account to pay for transaction fees (the tutorial will show how to fund newly generated keys via Friendbot).
3. **Soroban Contract ID**: The contract must be deployed on Stellar Testnet, and its Contract ID (e.g., `CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF`) must be known.
4. **TariffShield API**: The backend Express orchestrator must be running locally (`http://localhost:3002`) or deployed on Render.

---

## Step 1: Installation & Client Instantiation

First, install the TariffShield SDK and the underlying Stellar SDK:

```bash
npm install @tariff-shield/sdk @stellar/stellar-sdk
```

Now, instantiate the `TariffShieldClient`. The client manages RPC connections, transaction building, simulation, and submission.

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { TariffShieldClient } from "@tariff-shield/sdk";

// 1. Configure the connection options
const client = new TariffShieldClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF", // Replace with your contract ID
  networkPassphrase: "Test SDF Network ; September 2015",
  txTimeoutSeconds: 30,
});

// 2. Load the platform admin keypair (authorized to register importers and accrue yield)
const ADMIN_SECRET = "SA...ADMIN...SECRET...KEY"; // Replace with your actual admin secret
const adminKeypair = Keypair.fromSecret(ADMIN_SECRET);

console.log("TariffShieldClient instantiated successfully.");
console.log(`Admin Public Key: ${adminKeypair.publicKey()}`);
```

---

## Step 2: Registering an Importer

When a new importer signs up, they must be registered both in the off-chain database (via the API) and on-chain (via the Soroban contract).

The registration creates a zero-balance account on-chain and sets the initial collateral requirement.

```typescript
// Generate a new keypair for the importer
const importerKeypair = Keypair.random();
const importerAddress = importerKeypair.publicKey();
console.log(`Generated Importer Address: ${importerAddress}`);

// Define registration details
const bondId = 10123n;
const initialRequiredCollateral = 5000_0000000n; // 5,000 XLM/USDC in stroops (7 decimals)

async function registerNewImporter() {
  console.log("Registering importer on-chain...");
  
  // The platform admin signs and submits the registration transaction
  const response = await client.registerImporter(
    adminKeypair,
    importerAddress,
    bondId,
    initialRequiredCollateral
  );

  console.log(`✅ Importer registered on-chain.`);
  console.log(`Transaction Hash: ${response.txHash}`);
}

registerNewImporter().catch(console.error);
```

### What Happens Behind the Scenes:
*   **On-Chain Contract Storage**: The contract creates a new `Account` struct in its ledger storage, keyed by the importer's Stellar address. This struct initializes the `bond_id` and `required_collateral`, while setting the `collateral_balance`, `reserve_balance`, and `yield_accrued` to `0`.
*   **Off-Chain Database**: The TariffShield API records the importer's metadata (legal name, EIN, business state, and Stellar address) in the `importers` table, logs the bond details in `bond_records`, and tracks the registration transaction in `contract_events`.

---

## Step 3: Depositing Collateral

Once registered, the importer must deposit funds into their **collateral** bucket to meet the initial requirement. 

Before depositing, ensure the importer's Stellar account is funded with XLM to cover transaction fees and the deposit amount. On Testnet, you can fund the account using Friendbot:

```typescript
// Helper to fund the importer's account on Testnet
async function fundImporter() {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${importerAddress}`);
  if (!response.ok) {
    throw new Error("Failed to fund importer account via Friendbot");
  }
  console.log("Importer account funded with Testnet XLM.");
}
```

Now, perform the collateral deposit:

```typescript
async function depositImporterCollateral() {
  await fundImporter();

  const depositAmount = 5000_0000000n; // 5,000 XLM/USDC in stroops

  console.log("Depositing collateral...");
  // The importer signs the transaction to authorize transferring tokens to the contract
  const response = await client.depositCollateral(
    importerKeypair,  // Signer (pays fees and authorizes transfer)
    importerAddress,  // Importer account being credited
    importerAddress,  // Source of the funds
    depositAmount     // Amount in stroops
  );

  console.log(`✅ Collateral deposited.`);
  console.log(`Transaction Hash: ${response.txHash}`);
  console.log(`Verify on Stellar Expert: https://stellar.expert/explorer/testnet/tx/${response.txHash}`);
}

depositImporterCollateral().catch(console.error);
```

### Transaction Signing Flow:
1. The SDK builds a transaction invoking the contract's `deposit_collateral` function.
2. The transaction is simulated against the Soroban RPC server to generate the required ledger footprint and fee resource estimates.
3. The importer signs the prepared transaction with their private key, authorizing both the Soroban invocation and the underlying token transfer.
4. The transaction is submitted to the Stellar network and finalized.

---

## Step 4: Depositing Reserve

To protect against sudden tariff spikes, the importer can maintain an auto-top-up pool by depositing funds into their **reserve** bucket.

```typescript
async function depositImporterReserve() {
  const reserveAmount = 2500_0000000n; // 2,500 XLM/USDC in stroops

  console.log("Depositing reserve...");
  const response = await client.depositReserve(
    importerKeypair,  // Signer
    importerAddress,  // Importer account being credited
    importerAddress,  // Source of the funds
    reserveAmount     // Amount in stroops
  );

  console.log(`✅ Reserve deposited.`);
  console.log(`Transaction Hash: ${response.txHash}`);
}

depositImporterReserve().catch(console.error);
```

### Understanding the Buckets:
Both buckets map directly to the importer's `Account` entry on the ledger:
*   **Collateral Balance (`collateral_balance`)**: Locked funds. The importer cannot withdraw these if the withdrawal would cause the balance to fall below `required_collateral`.
*   **Reserve Balance (`reserve_balance`)**: Liquid funds. These are yield-bearing and can be withdrawn at any time or automatically drawn into the collateral bucket during a tariff spike.

---

## Step 5: Handling a Tariff Spike & Auto-Top-Up

When a tariff spike occurs (e.g., due to a new trade policy), the importer's required collateral increases. If the required collateral exceeds the active collateral balance, the `autoTopUp` function can be invoked to automatically move funds from the reserve bucket to the collateral bucket.

### 1. Simulate the Tariff Spike (API Call)
We upload a new tariff CSV to the API. The API recomputes the required collateral and updates it on-chain via the platform admin.

```typescript
async function simulateTariffSpike(importerId: string, jwtToken: string) {
  console.log("Uploading tariff CSV to simulate tariff spike...");
  
  const response = await fetch(`http://localhost:3002/importers/${importerId}/upload-tariff-csv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwtToken}`,
    },
    body: JSON.stringify({
      filename: "tariff_spike.csv",
      lineItems: [
        {
          htsCode: "8517.13.00", // Smart phones
          value: 500000,         // $500,000 import value
          dutyRate: 0.15,        // 15% duty rate (spike)
        }
      ]
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Tariff upload failed: ${data.error}`);
  }

  console.log(`Tariff spike processed. New Required Collateral: ${data.requiredCollateralStroops} stroops`);
  return BigInt(data.requiredCollateralStroops);
}
```

### 2. Trigger Auto-Top-Up and Verify
Once the requirement has increased on-chain, we call `autoTopUp()` to close the collateral gap using the reserve.

```typescript
async function handleSpikeAndTopUp(importerId: string, jwtToken: string) {
  // 1. Trigger the tariff spike on-chain via the API
  const newRequired = await simulateTariffSpike(importerId, jwtToken);

  // 2. Fetch the account state before top-up
  let account = await client.getAccount(importerAddress);
  console.log(`Before Auto-Top-Up:`);
  console.log(`  Collateral: ${account.collateralBalance} stroops`);
  console.log(`  Required:   ${account.requiredCollateral} stroops`);
  console.log(`  Reserve:    ${account.reserveBalance} stroops`);

  // 3. Trigger auto-top-up (permissionless: anyone can call this and pay gas)
  console.log("Triggering auto-top-up...");
  const topUpResult = await client.autoTopUp(importerKeypair, importerAddress);
  console.log(`✅ Auto-top-up completed. Moved ${topUpResult.result} stroops.`);

  // 4. Verify the new balance state
  account = await client.getAccount(importerAddress);
  console.log(`After Auto-Top-Up:`);
  console.log(`  Collateral: ${account.collateralBalance} stroops`);
  console.log(`  Required:   ${account.requiredCollateral} stroops`);
  console.log(`  Reserve:    ${account.reserveBalance} stroops`);
}
```

---

## Step 6: Accruing Yield

Yield on the collateral and reserve balances is simulated based on Franklin Templeton's BENJI tokenized T-bill. The surety admin periodically triggers yield accrual on-chain.

```typescript
async function accrueImporterYield() {
  // In a production environment, this is calculated based on the APY formula:
  // Yield = Balance * APY * (Elapsed Time / 365 Days)
  // For this demo, the surety admin accrues a flat 15 XLM/USDC (150,000,000 stroops)
  const yieldAmount = 15_0000000n; 

  console.log("Accruing yield...");
  // Only the authorized platform admin can call accrueYield
  const response = await client.accrueYield(
    adminKeypair,
    importerAddress,
    yieldAmount
  );

  console.log(`✅ Yield accrued.`);
  console.log(`Transaction Hash: ${response.txHash}`);

  // Read the updated account state to verify
  const account = await client.getAccount(importerAddress);
  console.log(`Updated Yield Accrued: ${account.yieldAccrued} stroops`);
}

accrueImporterYield().catch(console.error);
```

### Yield Rate Calculation Formula:
The yield rate is calculated off-chain using the following formula:

$$\Delta Y = B \times R_{\text{apy}} \times \frac{\Delta t}{31,536,000}$$

Where:
*   $\Delta Y$ is the new yield to accrue (in stroops).
*   $B$ is the total eligible balance ($\text{collateral\_balance} + \text{reserve\_balance}$).
*   $R_{\text{apy}}$ is the annualized yield rate (e.g., `0.045` for 4.5% APY).
*   $\Delta t$ is the elapsed time in seconds since the last accrual.
*   `31,536,000` is the number of seconds in a 365-day year.
