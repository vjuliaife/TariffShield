# SDK Network Configuration: Testnet vs Mainnet

`TariffShieldClient` accepts a `TariffShieldClientOptions` object. Two fields drive the network:
`rpcUrl` and `networkPassphrase`. Getting either wrong is the most common misconfiguration.

---

## Quick-start snippets

### Testnet

```typescript
import { TariffShieldClient } from '@tariff-shield/sdk';

const client = new TariffShieldClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'C...your-testnet-contract-id...',
  networkPassphrase: 'Test SDF Network ; September 2015',
});
```

### Mainnet

```typescript
import { TariffShieldClient } from '@tariff-shield/sdk';

const client = new TariffShieldClient({
  rpcUrl: 'https://mainnet.stellar.validationcloud.io/v1/<YOUR_KEY>',
  contractId: 'C...your-mainnet-contract-id...',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
});
```

> **Important:** Mainnet transactions cost real XLM and are irreversible. Always test on testnet first.

---

## All options

| Field | Type | Default | Description |
|---|---|---|---|
| `rpcUrl` | `string` | — | Soroban RPC endpoint. Required for any contract call. |
| `contractId` | `string` | — | Deployed contract address (`C…`). Required for any contract call. |
| `networkPassphrase` | `string` | `''` | Must match the network the contract is deployed on exactly. |
| `apiUrl` | `string` | — | Optional REST API base URL (`http://localhost:3002` locally, or your deployed API). |
| `apiKey` | `string` | — | Long-lived API key for machine-to-machine REST calls. |
| `sessionToken` | `string` | — | Short-lived JWT for REST calls. |
| `txTimeoutSeconds` | `number` | `30` | Transaction timeout. Increase if the RPC node is slow. |
| `skipCompatibilityCheck` | `boolean` | `false` | Skip contract version check on startup (useful in tests). |

---

## Switching an existing integration between networks

Only three values need to change:

```typescript
// Before (testnet)
const client = new TariffShieldClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'CTESTNET_CONTRACT_ID',
  networkPassphrase: 'Test SDF Network ; September 2015',
  apiUrl: 'https://tariffshield-api-staging.example.com',
});

// After (mainnet) — only rpcUrl, contractId, networkPassphrase, and apiUrl change
const client = new TariffShieldClient({
  rpcUrl: 'https://mainnet.stellar.validationcloud.io/v1/<YOUR_KEY>',
  contractId: 'CMAINNET_CONTRACT_ID',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  apiUrl: 'https://tariffshield-api.example.com',
});
```

Store these three values in environment variables so your code does not change:

```typescript
const client = new TariffShieldClient({
  rpcUrl: process.env.STELLAR_RPC_URL!,
  contractId: process.env.TARIFF_SHIELD_CONTRACT_ID!,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
  apiUrl: process.env.TARIFF_SHIELD_API_URL,
});
```

---

## Common misconfiguration pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `Transaction failed: bad auth` | `networkPassphrase` does not match the network the contract is on | Copy the exact passphrase string from the table above — trailing spaces matter |
| `Contract not found` | `contractId` is from a different network | Deploy the contract on the target network and use that ID |
| `simulate failed: host not accessible` | `rpcUrl` is wrong or rate-limited | Check the URL and verify your API key if the provider requires one |
| `CompatibilityError: sdk 0.1.0 requires contract ^0.x` | SDK version incompatible with deployed contract | Upgrade the SDK or redeploy a compatible contract; pass `skipCompatibilityCheck: true` to suppress during migration |
| Testnet transactions succeeding, mainnet failing | `apiUrl` still points to staging | Update `apiUrl` to the production API endpoint |

---

## Network passphrases reference

| Network | Passphrase |
|---|---|
| Testnet | `Test SDF Network ; September 2015` |
| Mainnet | `Public Global Stellar Network ; September 2015` |
| Futurenet | `Test SDF Future Network ; October 2022` |
| Local (quickstart) | `Standalone Network ; February 2017` |

---

## Related docs

- [API Authentication](../api/authentication.md)
- [SDK Tutorial](../sdk-tutorial.md)
- [Query Account Status Example](../examples/query-account-status.ts)
