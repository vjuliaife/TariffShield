# Mainnet Migration Checklist and Configuration Guide

This guide outlines the critical, irreversible steps for deploying TariffShield to the Stellar mainnet. Proceed with caution.

## 1. Asset Contract Address Swap
Circle USDC has a different contract ID on mainnet compared to testnet. Update all environments and initialization parameters:
- **Testnet USDC:** (Dependent on the testnet setup)
- **Mainnet USDC:** `CCW67TSZV3SSS2HXMZSKVSVDWHFWJZ6LLSQROKPEVG59H2DBDFVNE46U`
- Update `.env` files to point to the mainnet USDC contract ID if it is referenced explicitly.
- During contract initialization, use the mainnet USDC contract ID.

## 2. KYC Asset Configuration
USDC on mainnet requires strict authorization handling.
- **Flags:** Set `auth_required` and `auth_revocable` flags on the USDC trustline.
- **Process:**
  1. The platform must explicitly authorize new importer trustlines before they can hold USDC or transfer funds.
  2. If an importer becomes non-compliant, authorization can be revoked, freezing their assets immediately.

## 3. Ledger Hardware Wallet Setup for Admin Keypair
The `PLATFORM_STELLAR_SECRET` and `SURETY_STELLAR_SECRET` must not be software-backed for mainnet operations.

### Setup Instructions
1. Obtain a Ledger hardware wallet (Nano S Plus or Nano X).
2. Install the Stellar application via Ledger Live.
3. Open the Stellar app on the device.
4. Export the public key using Soroban CLI or Stellar Lab and ensure settings in `.env` reference the hardware wallet's public address (note: automated deployment scripts may need adaptation to prompt for hardware signing or use multi-sig).
5. For continuous deployment, use a multi-sig setup where a software key can propose, but a hardware key must approve (or adapt `.env` logic to use Ledger). 

## 4. Environment Variables Update
Ensure all configuration files are updated for mainnet:
- `STELLAR_NETWORK=public` (or `mainnet`)
- `STELLAR_RPC_URL=https://soroban-mainnet.stellar.org`
- `STELLAR_HORIZON_URL=https://horizon.stellar.org`
- `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`
- (Optional) `CIRCLE_API_KEY=` for programmatic fiat/USDC on/off-ramps

## 5. State Regulator Filing Checklist
Before going live, confirm regulatory compliance:
- [ ] **Money-Transmitter Licenses (MTL):** Ensure licenses are obtained in required operating states, or a sponsored model is in place.
- [ ] **FinCEN Registration:** Register as an MSB if applicable.
- [ ] **Disclosures:** Verify that required legal disclosures regarding the tariff bond instrument on a public blockchain are accessible to all users.

## 6. Re-deployment Sequence
Execute the deployment in this explicit order:
1. **Fund Admin Account:** Ensure the admin account holds sufficient XLM for transaction fees and minimum balances.
2. **Deploy WASM:** Deploy the smart contract WASM to the network.
3. **Initialize Contract:** Initialize with the admin address and the mainnet USDC contract ID.
4. **Configure USDC Asset:** Set up trustlines and configure authorization flags.
5. **Verify Entrypoints:** Run read-only smoke tests (like `scripts/sdk-smoke.ts` adapted for mainnet) against the contract.
6. **Communicate to Users:** Open the platform for user interaction.

## 7. User Communication Plan Template
Notify importers 7 days prior to migration.

**Subject:** Upcoming Mainnet Launch and Scheduled Maintenance

**Body:**
> Dear Importer,
> 
> We are excited to announce that TariffShield is moving to the Stellar Mainnet on [Date] at [Time]. This marks our transition from testnet to using real Circle USDC for tariff bonds.
> 
> **Expected Downtime:** [Duration] starting at [Time]. During this window, you will not be able to log in or post new collateral.
> 
> **Required Actions:** 
> - After the migration window, please log in to re-authorize your USDC trustlines.
> - Ensure your organization has completed the updated KYC verification process.
> 
> If you have any questions, please contact our support team.
> 
> Sincerely,
> The TariffShield Team
