# Soroban Smart-Contract Primer

A minimal guide for TariffShield contributors who are comfortable with TypeScript/Express
but new to Stellar and Soroban.

---

## Why Stellar?

TariffShield uses Stellar because:

- **Low, predictable fees** — Soroban operations cost fractions of a cent at current base
  reserve levels, making micro-collateral updates economically viable.
- **USDC as first-class collateral** — Stellar hosts Circle's native USDC issuance, so the
  contract can hold and transfer USDC without wrapping or bridging.
- **Built-in multi-sig and auth primitives** — `require_auth()` lets the contract express
  "only the importer herself can withdraw her collateral" without rolling custom access
  control, reducing the attack surface.
- **Rust toolchain** — Soroban contracts are compiled to WASM from Rust, giving formal
  correctness guarantees and access to the Rust type system.

---

## Key Concepts

### Addresses and Keypairs

Every Stellar actor (user, contract, oracle) is identified by an **address**. There are two
kinds:

| Kind | Prefix | Description |
|------|--------|-------------|
| G-account | `G...` (56 chars) | A standard public key — human wallet or service keypair |
| C-account | `C...` (56 chars) | A deployed contract address |

TariffShield environment variables you'll encounter:

```
SECRET_KEY          # Ed25519 secret for the platform admin G-account
ORACLE_SECRET_KEY   # Separate Ed25519 secret for the oracle admin G-account
SOROBAN_RPC_URL     # JSON-RPC endpoint (testnet: https://soroban-testnet.stellar.org)
NETWORK_PASSPHRASE  # "Test SDF Network ; September 2015" (testnet)
CONTRACT_ID         # C-address of the deployed tariff-shield contract
```

### Ledger and Storage

Think of the Soroban ledger as a global key-value store that the contract reads and writes.
There are three storage tiers:

| Tier | TTL | Cost | Use case |
|------|-----|------|----------|
| `Persistent` | Survives ledger archival (with TTL bump) | Moderate | Long-lived state — importer balances, required collateral |
| `Temporary` | Automatically deleted after TTL | Low | Short-lived flags — rate-limit timestamps |
| `Instance` | Lives as long as the contract instance | Included in base fee | Contract-wide config — admin list, oracle address |

TariffShield stores importer records in `Persistent` storage under a
`DataKey::Importer(address)` enum variant.

### Transactions

A **Soroban transaction** is a Stellar transaction (`TransactionEnvelope`) that contains
exactly one `InvokeHostFunction` operation targeting a contract entrypoint. The API uses
`@stellar/stellar-sdk` to build and submit these:

```ts
const tx = new TransactionBuilder(sourceAccount, { fee, networkPassphrase })
  .addOperation(
    Operation.invokeContractFunction({
      contract: contractId,
      function: "deposit_collateral",
      args: xdr.ScVal[]
    })
  )
  .setTimeout(30)
  .build();

const signed = tx.sign(keypair);
await server.sendTransaction(signed);
```

The API waits for the transaction hash to appear in a `getTransaction` poll loop (see
`apps/api/src/stellar.ts`).

---

## Express API vs. Soroban Contract — Responsibility Split

| Concern | Express API | Soroban contract |
|---------|------------|-----------------|
| Authentication | JWT (`authMiddleware`) | `require_auth()` on callers |
| Business logic | Collateral formula, CSV parsing | Cap guards, rate limiting |
| Data storage | PostgreSQL (PII, tariff CSVs) | Balances, required collateral |
| Role enforcement | `requireRole(...)` middleware | `surety` / `admins` address checks |
| Auditability | Server logs | Immutable ledger history |

The API is the **write path for off-chain data** and the **bridge** for on-chain
transactions. The contract is the **source of truth for money**.

---

## Wallets and Key Management

**For importers (frontend users):**
Importers connect a browser wallet (Freighter, Lobstr, or any SEP-7 wallet) via Stellar
Wallet Kit. The wallet signs transactions containing `withdraw_collateral` or
`raise_dispute` invocations in-browser. **The importer's private key never reaches the
API server.**

**For the API (custodial operations):**
Admin and oracle operations (`register_importer`, `set_required_collateral`, `accrue_yield`)
are signed by the API server using `SECRET_KEY` / `ORACLE_SECRET_KEY` loaded from
environment variables. These keys must be stored in a secret manager (AWS Secrets Manager,
Vault) in production — never committed to source control.

**Generating a new testnet keypair:**
```bash
stellar keys generate --global alice --network testnet
stellar keys address alice
# Fund with Friendbot:
curl "https://friendbot.stellar.org/?addr=$(stellar keys address alice)"
```

---

## Contract Entrypoints

All public entrypoints live in `contracts/tariff-shield/src/lib.rs` under `impl
TariffShieldContract`. Each is decorated with `#[contractimpl]`.

```rust
pub fn deposit_collateral(env: Env, from: Address, amount: i128) {
    from.require_auth();                            // wallet must sign
    let mut importer = storage::load_importer(&env, &from);
    importer.collateral_balance += amount;
    storage::save_importer(&env, &from, &importer);
    token::transfer(&env, &from, &env.current_contract_address(), &amount);
}
```

Key patterns to recognise:

| Pattern | What it does |
|---------|-------------|
| `from.require_auth()` | Asserts the `from` address approved this call |
| `env.storage().persistent().get(&key)` | Read from persistent ledger storage |
| `env.storage().persistent().set(&key, &val)` | Write to persistent ledger storage |
| `token::transfer(...)` | Transfer a Stellar asset (wraps SAC token interface) |
| `env.ledger().timestamp()` | Current ledger close time (Unix seconds) |
| `panic_with_error!(env, Error::SomeVariant)` | Abort with a typed contract error |

---

## Testing Contracts

Soroban provides an in-process test environment — no node needed:

```rust
#[test]
fn test_deposit() {
    let env = Env::default();
    env.mock_all_auths();          // bypass require_auth() checks

    let admin = Address::generate(&env);
    let contract_id = env.register(TariffShieldContract, ());
    let client = TariffShieldContractClient::new(&env, &contract_id);

    // manipulate ledger state
    env.ledger().with_mut(|li| li.timestamp = 1_000_000);

    client.initialize(&admin, /* … */);
    client.deposit_collateral(&importer_addr, &1_000_000i128);

    let record = client.get_importer(&importer_addr);
    assert_eq!(record.collateral_balance, 1_000_000i128);
}
```

Key test helpers:

| Helper | Purpose |
|--------|---------|
| `env.mock_all_auths()` | Skip all `require_auth()` calls — use in unit tests |
| `env.ledger().with_mut(\|li\| li.timestamp = T)` | Fast-forward ledger time |
| `client.try_<fn>(...)` | Returns `Result<T, Err>` instead of panicking |
| `Address::generate(&env)` | Create a fresh random address |

The test suite lives in `contracts/tariff-shield/src/test.rs`.

---

## Further Reading

| Resource | URL |
|----------|-----|
| Soroban docs | https://developers.stellar.org/docs/build/smart-contracts |
| Stellar SDK (JS) | https://stellar.github.io/js-stellar-sdk |
| Rust `soroban-sdk` crate | https://docs.rs/soroban-sdk |
| Soroban testnet | https://soroban-testnet.stellar.org |
| Freighter wallet | https://www.freighter.app |
