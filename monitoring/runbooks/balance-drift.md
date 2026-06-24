# Runbook: Balance Drift Investigation and Recovery

## Overview
Balance drift occurs when the `collateral_balance` recorded in our PostgreSQL database differs from the authoritative balance stored in the Soroban smart contract by more than 0.1%.

## Investigation Steps
1. **Identify Drifted Bonds**: Search the API logs for the message "Balance drift detected for bond!" to find which `bondId`s are affected.
2. **Review On-Chain State**: Use a Stellar explorer or the `soroban-cli` to query the contract state for the affected bond directly.
3. **Review Database State**: Query the `importers` and `contract_events` tables for the affected bond.
4. **Determine Authoritative Source**:
   - The **Soroban Contract** is always the authoritative source for funds.
   - If the chain balance is correct, the DB is out of sync (possibly due to indexer lag or missed events).
   - If the chain balance is unexpected, investigate recent on-chain transactions that might have bypassed the API.

## Manual Recovery Procedure
To re-sync the database balance with the on-chain balance:
1. **Pause the Indexer**: Temporarily stop the indexing process to prevent race conditions during manual updates.
2. **Update the Database**: Run a manual SQL query to update the `collateral_balance` for the affected bond to match the on-chain value.
   ```sql
   UPDATE importers SET collateral_balance = <actual_balance> WHERE bond_id = '<bond_id>';
   ```
3. **Verify**: Wait for the next reconciliation job run (max 5 minutes) and ensure the `contract_balance_drift_count` gauge returns to 0.
4. **Resume Indexer**: Restart the indexer and monitor for any immediate regression.

## Prevention
If drift occurs frequently, investigate the `contract_event_indexer` for reliability issues or potential race conditions between event processing and internal state updates.
