#![no_std]
//! TariffShield — Soroban customs-bond collateral escrow.
//!
//! Per importer the contract tracks:
//!   - collateral_balance     USDC currently posted as surety collateral
//!   - required_collateral    amount surety requires (oracle-set; reflects tariff exposure)
//!   - reserve_balance        USDC held as auto-top-up source (importer's "spare" funds)
//!   - yield_accrued          simulated BENJI yield (mainnet replaces with real fund flow)
//!   - is_clawbacked          frozen state after surety enforcement

use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, symbol_short, token, Address, BytesN,
    Env, Symbol, Vec,
};

mod errors;
mod test;

pub use errors::Error;

/// The main TariffShield contract structure.
#[contract]
pub struct TariffShieldContract;

/// Storage keys for the contract's persistent and instance storage.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Vector of platform admin addresses.
    Admins,
    /// The surety admin address with clawback capability.
    Surety,
    /// The SAC token contract address used for collateral.
    Token,
    /// Per-importer account state, keyed by importer address.
    Account(Address),
    /// Upgrade proposal state, keyed by proposal ID.
    Proposal(u64),
    /// Counter for generating unique upgrade proposal IDs.
    ProposalCounter,
    /// Address of the price oracle contract.
    PriceOracle,
    /// Current contract version.
    Version,
    /// Dedicated oracle administrator address.
    OracleAdmin,
    /// Emergency oracle administrator address.
    EmergencyOracleAdmin,
    /// Tracks whether an address has updated.
    HasUpdated(Address),
    /// Vector of authorized oracle signers.
    OracleSigners,
    /// Threshold of approvals required to update oracle signers.
    OracleThreshold,
}

/// Represents a proposed contract WASM upgrade.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    /// The WASM hash of the proposed new contract code.
    pub new_wasm_hash: BytesN<32>,
    /// List of admin addresses who have approved the upgrade.
    pub approvals: Vec<Address>,
    /// Ledger sequence number at which the proposal expires.
    pub expiry_ledger: u32,
}

/// Represents a single historical record in the required collateral audit trail.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralHistoryEntry {
    /// The required collateral value in stroops.
    pub value: i128,
    /// The ledger timestamp when the value was set.
    pub timestamp: u64,
}

/// Represents the escrow and state tracking account for an importer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Account {
    /// Unique identifier for the importer's customs bond.
    pub bond_id: u64,
    /// Active collateral balance currently posted in stroops.
    pub collateral_balance: i128,
    /// Collateral amount required by the surety in stroops.
    pub required_collateral: i128,
    /// Auto-top-up reserve balance in stroops.
    pub reserve_balance: i128,
    /// Simulated accrued yield in stroops.
    pub yield_accrued: i128,
    /// Flag indicating if the account has been clawed back and frozen.
    pub is_clawbacked: bool,
    /// Ledger timestamp of the last collateral state modification.
    pub collateral_last_updated: u64,
    /// Rolling history of the last 12 required collateral values.
    pub collateral_history: Vec<CollateralHistoryEntry>,
    /// Ledger timestamp when the active dispute window expires.
    pub dispute_expires_at: u64,
    /// Pre-dispute required collateral value in stroops.
    pub pre_dispute_required: i128,
    /// Flag indicating if a formal dispute has been raised by the importer.
    pub dispute_raised: bool,
    /// Ledger timestamp when the oracle last updated the requirement.
    pub oracle_last_updated: u64,
}

#[contractimpl]
impl TariffShieldContract {
    /// Initializes the contract state and configures administrators, surety, and token roles.
    ///
    /// This is a one-shot function and can only be called once. All administrator, oracle,
    /// and emergency oracle administrators must authorize this call by signing.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `admins`: A vector of admin addresses who manage the platform. At least one admin is required.
    /// - `surety`: The address of the surety administrator who possesses clawback capabilities.
    /// - `token`: The SAC (Stellar Asset Contract) token address used for collateral.
    /// - `oracle_admin`: The address of the oracle administrator authorized to update required collateral. Set to same as `admins[0]` if not separate.
    /// - `emergency_oracle_admin`: The address of the emergency oracle admin authorized to bypass rate limits.
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::AlreadyInitialized`: If the contract has already been initialized.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source admin \
    ///   -- \
    ///   initialize \
    ///   --admins '["GBEB3I..."]' \
    ///   --surety "GDLZFC..." \
    ///   --token "CAS3GD..." \
    ///   --oracle_admin "GBEB3I..." \
    ///   --emergency_oracle_admin "GDEB3I..."
    /// ```
    pub fn initialize(
        env: Env,
        admins: Vec<Address>,
        surety: Address,
        token: Address,
        oracle_admin: Address,
        emergency_oracle_admin: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admins) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        for admin in admins.iter() {
            admin.require_auth();
        }
        oracle_admin.require_auth();
        emergency_oracle_admin.require_auth();
        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage().instance().set(&DataKey::Surety, &surety);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::OracleAdmin, &oracle_admin);
        env.storage()
            .instance()
            .set(&DataKey::EmergencyOracleAdmin, &emergency_oracle_admin);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCounter, &0u64);
        let empty_signers: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::OracleSigners, &empty_signers);
        env.storage()
            .instance()
            .set(&DataKey::OracleThreshold, &2u32);
    }

    /// Registers a new importer and creates a zero-balance escrow account.
    ///
    /// This function must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the importer being registered.
    /// - `bond_id`: The unique identifier of the customs bond.
    /// - `required_collateral`: The initial required collateral amount in stroops. Must be >= 0.
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::NotInitialized`: If the contract is not initialized.
    /// - `Error::NotAnAdmin`: If the caller is not a configured platform admin.
    /// - `Error::InvalidAmount`: If `required_collateral` is negative.
    /// - `Error::ImporterAlreadyRegistered`: If an account for the importer already exists.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source admin \
    ///   -- \
    ///   register_importer \
    ///   --importer "GDIMPO..." \
    ///   --bond_id 123456 \
    ///   --required_collateral 1000000000
    /// ```
    pub fn register_importer(env: Env, importer: Address, bond_id: u64, required_collateral: i128) {
        let admin = get_admin(&env);
        admin.require_auth();
        if required_collateral < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let key = DataKey::Account(importer.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::ImporterAlreadyRegistered);
        }
        let account = Account {
            bond_id,
            collateral_balance: 0,
            required_collateral,
            reserve_balance: 0,
            yield_accrued: 0,
            is_clawbacked: false,
            // Registration sets the staleness clock; oracle_last_updated stays 0 so the
            // first set_required_collateral call is not blocked by the 24-hour rate limit.
            collateral_last_updated: env.ledger().timestamp(),
            collateral_history: Vec::new(&env),
            dispute_expires_at: 0,
            pre_dispute_required: required_collateral,
            dispute_raised: false,
            oracle_last_updated: 0,
        };
        env.storage().persistent().set(&key, &account);
        env.events().publish(
            (symbol_short!("registr"), importer.clone()),
            (bond_id, required_collateral),
        );
    }

    /// Deposits SAC tokens into the importer's active collateral balance.
    ///
    /// The depositor (`from`) must authorize the transfer. The contract transfers the tokens
    /// from the depositor's account to its own address.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `from`: The Stellar address of the fund source authorizing the deposit.
    /// - `amount`: The amount of SAC tokens to deposit in stroops. Must be > 0.
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::InvalidAmount`: If `amount` is <= 0.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account has been clawed back and frozen.
    /// - `Error::StaleOracleError`: If the importer's collateral data is stale (> 365 days since update).
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source importer \
    ///   -- \
    ///   deposit_collateral \
    ///   --importer "GDIMPO..." \
    ///   --from "GDIMPO..." \
    ///   --amount 500000000
    /// ```
    pub fn deposit_collateral(env: Env, importer: Address, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        require_fresh_collateral(&env, &importer, &acct);
        let token_addr = get_token(&env);
        token::Client::new(&env, &token_addr).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        acct.collateral_balance += amount;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("deposit"), importer.clone()),
            (amount, acct.collateral_balance),
        );
    }

    /// Deposits SAC tokens into the importer's auto-top-up reserve balance.
    ///
    /// The depositor (`from`) must authorize the transfer. These funds are held separately
    /// and can be automatically moved to the collateral balance via `auto_top_up`.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `from`: The Stellar address of the fund source authorizing the deposit.
    /// - `amount`: The amount of SAC tokens to deposit in stroops. Must be > 0.
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::InvalidAmount`: If `amount` is <= 0.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account has been clawed back and frozen.
    /// - `Error::StaleOracleError`: If the importer's collateral data is stale (> 365 days since update).
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source importer \
    ///   -- \
    ///   deposit_reserve \
    ///   --importer "GDIMPO..." \
    ///   --from "GDIMPO..." \
    ///   --amount 300000000
    /// ```
    pub fn deposit_reserve(env: Env, importer: Address, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        require_fresh_collateral(&env, &importer, &acct);
        let token_addr = get_token(&env);
        token::Client::new(&env, &token_addr).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        acct.reserve_balance += amount;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("reserve"), importer.clone()),
            (amount, acct.reserve_balance),
        );
    }

    /// Updates the required collateral for a registered importer.
    ///
    /// This function can be called by the oracle administrator or the emergency oracle administrator.
    /// By default, updates are rate-limited to once per 24 hours, and requirements cannot increase by
    /// more than 5x in a single step (unless bypassed/emergency). It also opens a 72-hour dispute window.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `caller`: The Stellar address of the oracle admin or emergency oracle admin invoking the call.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `new_required`: The new required collateral amount in USD/stroops. Must be >= 0.
    /// - `price_oracle_contract`: Optional price oracle address to fetch the USDC/USD rate for adjustment.
    /// - `bypass_rate_limit`: If true, bypasses the 24-hour rate limit check.
    /// - `emergency`: If true, indicates an emergency update (must be signed by the emergency oracle admin).
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::UnauthorizedEmergencyOverride`: If `emergency` is true but `caller` is not the emergency oracle admin.
    /// - `Error::UnauthorizedRole`: If `emergency` is false but `caller` is not the oracle admin.
    /// - `Error::InvalidAmount`: If `new_required` is negative.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::RateLimitExceededError`: If the rate limit is violated and not bypassed.
    /// - `Error::CollateralCapExceeded`: If the new requirement is more than 5x the previous requirement.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source oracle \
    ///   -- \
    ///   set_required_collateral \
    ///   --caller "GDORAC..." \
    ///   --importer "GDIMPO..." \
    ///   --new_required 2000000000 \
    ///   --price_oracle_contract "CAS3GD..." \
    ///   --bypass_rate_limit false \
    ///   --emergency false
    /// ```
    pub fn set_required_collateral(
        env: Env,
        caller: Address,
        importer: Address,
        new_required: i128,
        price_oracle_contract: Option<Address>,
        bypass_rate_limit: bool,
        emergency: bool,
    ) {
        caller.require_auth();
        if emergency {
            let emergency_admin = get_emergency_oracle_admin(&env);
            if caller != emergency_admin {
                panic_with_error!(&env, Error::UnauthorizedEmergencyOverride);
            }
        } else {
            let oracle_admin = get_oracle_admin(&env);
            if caller != oracle_admin {
                panic_with_error!(&env, Error::UnauthorizedRole);
            }
        }

        if new_required < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        let current_timestamp = env.ledger().timestamp();

        // Rate limit: max one oracle update per 24 hours.
        // Uses oracle_last_updated (not collateral_last_updated) so registration does
        // not count against the first oracle update.
        let cooldown_seconds: u64 = 86400;
        if !bypass_rate_limit && !emergency && acct.oracle_last_updated > 0 {
            if current_timestamp < acct.oracle_last_updated + cooldown_seconds {
                let retry_after = acct.oracle_last_updated + cooldown_seconds;
                env.events()
                    .publish((symbol_short!("ratelimit"), importer.clone()), retry_after);
                panic_with_error!(&env, Error::RateLimitExceededError);
            }
        }

        let oracle_rate: i128 = if let Some(oracle_addr) = price_oracle_contract.clone() {
            get_usdc_usd_rate(&env, &oracle_addr)
        } else if let Some(oracle_addr) = get_price_oracle_optional(&env) {
            get_usdc_usd_rate(&env, &oracle_addr)
        } else {
            10000
        };

        let adjusted_required = if oracle_rate != 10000 {
            ((new_required as i128) * 10000) / oracle_rate
        } else {
            new_required
        };

        if oracle_rate < 9800 || oracle_rate > 10200 {
            env.events()
                .publish((symbol_short!("depeg"), importer.clone()), oracle_rate);
        }

        let old_required = acct.required_collateral;

        // #326 — reject any single update that more than 5× the current value.
        // Allows large legitimate increases through multi-step escalation while
        // bounding the damage from a compromised or misconfigured oracle key.
        if old_required > 0 && adjusted_required > old_required.saturating_mul(5) {
            panic_with_error!(&env, Error::CollateralCapExceeded);
        }

        // #331 — append the old value to the rolling on-chain audit trail before update.
        let entry = CollateralHistoryEntry {
            value: old_required,
            timestamp: current_timestamp,
        };
        acct.collateral_history.push_back(entry);
        let hist_len = acct.collateral_history.len();
        if hist_len > 12 {
            let start = hist_len - 12;
            let mut trimmed = Vec::new(&env);
            for i in start..hist_len {
                trimmed.push_back(acct.collateral_history.get(i).unwrap());
            }
            acct.collateral_history = trimmed;
        }

        // #336 — open a 72-hour window during which the importer may raise a dispute.
        // Any existing dispute is cleared because the oracle has issued a new value.
        acct.pre_dispute_required = old_required;
        acct.dispute_expires_at = current_timestamp + 72 * 3600;
        acct.dispute_raised = false;

        acct.required_collateral = adjusted_required;
        acct.collateral_last_updated = current_timestamp;
        acct.oracle_last_updated = current_timestamp;
        save_account(&env, &importer, &acct);
        if emergency {
            env.events().publish(
                (Symbol::new(&env, "EmergencyOracleUpdate"), importer.clone()),
                (old_required, adjusted_required, current_timestamp, caller),
            );
        } else {
            env.events().publish(
                (symbol_short!("required"), importer.clone()),
                (old_required, adjusted_required),
            );
        }
    }

    /// Rotate the oracle signer set — requires 2-of-3 from the current signer set.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `new_signers`: A vector of 3 new signer addresses.
    /// - `approvals`: A vector of addresses that approve this update.
    ///
    /// # Panics
    /// - `Error::InvalidSignatureSet`: If `new_signers` length is not 3, or if duplicate addresses exist in `approvals`.
    /// - `Error::InsufficientSignatures`: If the number of valid signatures is less than the threshold.
    /// - `Error::NotInitialized`: If the contract is not initialized.
    pub fn update_oracle_signers(env: Env, new_signers: Vec<Address>, approvals: Vec<Address>) {
        if new_signers.len() != 3 {
            panic_with_error!(&env, Error::InvalidSignatureSet);
        }
        let oracle_signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::OracleSigners)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::OracleThreshold)
            .unwrap_or(2u32);

        let mut seen = Vec::new(&env);
        let mut valid_count: u32 = 0;
        for signer in approvals.iter() {
            if seen.contains(signer.clone()) {
                panic_with_error!(&env, Error::InvalidSignatureSet);
            }
            seen.push_back(signer.clone());
            if oracle_signers.contains(signer.clone()) {
                signer.require_auth();
                valid_count += 1;
            }
        }
        if valid_count < threshold {
            panic_with_error!(&env, Error::InsufficientSignatures);
        }
        env.storage()
            .instance()
            .set(&DataKey::OracleSigners, &new_signers);
    }

    /// Returns the list of currently authorized oracle signers.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// A vector containing the addresses of the authorized oracle signers.
    pub fn get_oracle_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::OracleSigners)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Automatically transfers funds from the reserve balance to the collateral balance.
    ///
    /// This function is permissionless and can be called by anyone. It moves up to the shortfall
    /// amount from `reserve_balance` to `collateral_balance` to meet the `required_collateral`.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    ///
    /// # Returns
    /// An `i128` representing the amount of tokens moved from reserve to collateral in stroops.
    ///
    /// # Panics
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account has been clawed back.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source any_user \
    ///   -- \
    ///   auto_top_up \
    ///   --importer "GDIMPO..."
    /// ```
    pub fn auto_top_up(env: Env, importer: Address) -> i128 {
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        // #336 — during an active dispute use the pre-dispute value so auto-top-up
        // does not force the importer to fund the disputed (higher) requirement.
        let effective_required = effective_required(&acct);
        let shortfall = effective_required - acct.collateral_balance;
        if shortfall <= 0 || acct.reserve_balance <= 0 {
            return 0;
        }
        let moved = if shortfall < acct.reserve_balance {
            shortfall
        } else {
            acct.reserve_balance
        };
        acct.collateral_balance += moved;
        acct.reserve_balance -= moved;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("topup"), importer.clone()),
            (moved, acct.collateral_balance, acct.reserve_balance),
        );
        moved
    }

    /// Withdraws collateral from the importer's account to a specified address.
    ///
    /// The importer must authorize this transaction. The withdrawal is rejected if it would
    /// cause the active collateral balance to fall below the required collateral.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `to`: The Stellar address receiving the withdrawn tokens.
    /// - `amount`: The amount of collateral to withdraw in stroops. Must be > 0.
    ///
    /// # Returns
    /// This function returns nothing (`()`).
    ///
    /// # Panics
    /// - `Error::InvalidAmount`: If `amount` is <= 0.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account has been clawed back.
    /// - `Error::StaleOracleError`: If the importer's collateral data is stale (> 365 days since update).
    /// - `Error::CollateralBelowRequired`: If the withdrawal would breach the required collateral threshold.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source importer \
    ///   -- \
    ///   withdraw_collateral \
    ///   --importer "GDIMPO..." \
    ///   --to "GDIMPO..." \
    ///   --amount 100000000
    /// ```
    pub fn withdraw_collateral(env: Env, importer: Address, to: Address, amount: i128) {
        importer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        require_fresh_collateral(&env, &importer, &acct);
        // #336 — during an active dispute enforce the pre-dispute (lower) required value,
        // letting the importer withdraw excess they would not be forced to lock under dispute.
        let req = effective_required(&acct);
        let excess = acct.collateral_balance - req;
        if amount > excess {
            panic_with_error!(&env, Error::CollateralBelowRequired);
        }
        let token_addr = get_token(&env);
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        acct.collateral_balance -= amount;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("withdraw"), importer.clone()),
            (amount, acct.collateral_balance),
        );
    }

    /// Accrues simulated yield to the importer's account.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `amount`: The yield amount to accrue in stroops. Must be > 0.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    /// - `Error::InvalidAmount`: If `amount` is <= 0.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account is clawed back.
    pub fn accrue_yield(env: Env, importer: Address, amount: i128) {
        let admin = get_admin(&env);
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        acct.yield_accrued += amount;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("yield"), importer.clone()),
            (amount, acct.yield_accrued),
        );
    }

    /// Liquidates all collateral and reserve balances of an importer to the surety.
    ///
    /// Must be authorized by the surety admin. The importer's account is permanently frozen
    /// (marked as clawed back) after this operation.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    ///
    /// # Returns
    /// An `i128` representing the total liquidated amount (collateral + reserve) transferred to the surety in stroops.
    ///
    /// # Panics
    /// - `Error::NotInitialized`: If the contract is not initialized.
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    ///
    /// # Example
    /// ```bash
    /// stellar contract invoke \
    ///   --id CDLZFC3SYJ... \
    ///   --network testnet \
    ///   --source surety \
    ///   -- \
    ///   clawback \
    ///   --importer "GDIMPO..."
    /// ```
    pub fn clawback(env: Env, importer: Address) -> i128 {
        let surety = get_surety(&env);
        surety.require_auth();
        let mut acct = load_account(&env, &importer);
        let total = acct.collateral_balance + acct.reserve_balance;
        if total == 0 {
            acct.is_clawbacked = true;
            save_account(&env, &importer, &acct);
            return 0;
        }
        let token_addr = get_token(&env);
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &surety,
            &total,
        );
        acct.collateral_balance = 0;
        acct.reserve_balance = 0;
        acct.is_clawbacked = true;
        save_account(&env, &importer, &acct);
        env.events()
            .publish((symbol_short!("clawback"), importer.clone()), total);
        total
    }

    /// Contests the most recent oracle-set required_collateral value.
    ///
    /// Must be called by the importer within the 72-hour window opened by `set_required_collateral`.
    /// While a dispute is raised, the contract enforces the pre-dispute required collateral value.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    ///
    /// # Panics
    /// - `Error::ImporterNotRegistered`: If the importer is not registered.
    /// - `Error::AccountFrozen`: If the importer's account is clawed back.
    /// - `Error::NoDisputeWindow`: If the 72-hour dispute window has expired or was never opened.
    /// - `Error::DisputeAlreadyRaised`: If a dispute has already been raised and is pending resolution.
    pub fn raise_dispute(env: Env, importer: Address) {
        importer.require_auth();
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        let current_ts = env.ledger().timestamp();
        if acct.dispute_expires_at == 0 || current_ts >= acct.dispute_expires_at {
            panic_with_error!(&env, Error::NoDisputeWindow);
        }
        if acct.dispute_raised {
            panic_with_error!(&env, Error::DisputeAlreadyRaised);
        }
        acct.dispute_raised = true;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("dispute"), importer.clone()),
            (acct.pre_dispute_required, acct.required_collateral),
        );
    }

    /// Resolves an open importer dispute.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    /// - `accept`: If true, the new oracle requirement is accepted. If false, it is reverted to the pre-dispute value.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    /// - `Error::NoActiveDispute`: If no active dispute exists for the importer.
    pub fn resolve_dispute(env: Env, importer: Address, accept: bool) {
        let admin = get_admin(&env);
        admin.require_auth();
        let mut acct = load_account(&env, &importer);
        if !acct.dispute_raised {
            panic_with_error!(&env, Error::NoActiveDispute);
        }
        if !accept {
            acct.required_collateral = acct.pre_dispute_required;
        }
        acct.dispute_raised = false;
        acct.dispute_expires_at = 0;
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("disprsol"), importer.clone()),
            (accept, acct.required_collateral),
        );
    }

    /// Returns the rolling on-chain history of the last 12 required collateral values.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the registered importer.
    ///
    /// # Returns
    /// A vector of `CollateralHistoryEntry` records.
    pub fn get_collateral_history(env: Env, importer: Address) -> Vec<CollateralHistoryEntry> {
        load_account(&env, &importer).collateral_history
    }

    /// Proposes a contract WASM code upgrade.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `caller`: The admin address proposing the upgrade.
    /// - `new_wasm_hash`: The WASM hash of the new contract code.
    ///
    /// # Returns
    /// The unique ID of the created upgrade proposal.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    pub fn propose_upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> u64 {
        require_admin(&env, &caller);
        caller.require_auth();

        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCounter)
            .unwrap_or(0);
        let proposal_id = counter + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCounter, &proposal_id);

        let mut approvals = Vec::new(&env);
        approvals.push_back(caller.clone());

        let expiry_ledger = env.ledger().sequence() + 17280; // ~1 day at 5s/ledger

        let proposal = Proposal {
            new_wasm_hash,
            approvals,
            expiry_ledger,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        proposal_id
    }

    /// Approves a proposed contract WASM code upgrade.
    ///
    /// Must be authorized by a platform administrator. Once 2 approvals are collected,
    /// the contract WASM is immediately upgraded.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `caller`: The admin address approving the upgrade.
    /// - `proposal_id`: The unique ID of the upgrade proposal.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    /// - `Error::ProposalNotFound`: If the proposal does not exist.
    /// - `Error::ProposalExpired`: If the proposal has expired.
    /// - `Error::AlreadyVoted`: If the caller has already approved this proposal.
    pub fn approve_upgrade(env: Env, caller: Address, proposal_id: u64) {
        require_admin(&env, &caller);
        caller.require_auth();

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProposalNotFound));

        if env.ledger().sequence() > proposal.expiry_ledger {
            env.storage().persistent().remove(&key);
            panic_with_error!(&env, Error::ProposalExpired);
        }

        if proposal.approvals.contains(caller.clone()) {
            panic_with_error!(&env, Error::AlreadyVoted);
        }

        proposal.approvals.push_back(caller);

        if proposal.approvals.len() >= 2 {
            env.deployer()
                .update_current_contract_wasm(proposal.new_wasm_hash);
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &proposal);
        }
    }

    /// Cancels a proposed contract WASM code upgrade.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `caller`: The admin address canceling the upgrade.
    /// - `proposal_id`: The unique ID of the upgrade proposal.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    /// - `Error::ProposalNotFound`: If the proposal does not exist.
    pub fn cancel_upgrade(env: Env, caller: Address, proposal_id: u64) {
        require_admin(&env, &caller);
        caller.require_auth();

        let key = DataKey::Proposal(proposal_id);
        if !env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::ProposalNotFound);
        }
        env.storage().persistent().remove(&key);
    }

    /// Returns the complete account state for an importer.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `importer`: The Stellar address of the importer.
    ///
    /// # Returns
    /// The `Account` struct containing all balances and metadata.
    pub fn get_account(env: Env, importer: Address) -> Account {
        load_account(&env, &importer)
    }

    /// Checks if the importer's collateral data is stale (no updates in > 365 days).
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `account_id`: The Stellar address of the importer.
    ///
    /// # Returns
    /// `true` if the data is stale, `false` otherwise.
    pub fn is_collateral_stale(env: Env, account_id: Address) -> bool {
        let acct = load_account(&env, &account_id);
        is_stale(&env, &acct)
    }

    /// Returns the primary platform admin address.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// The `Address` of the platform admin.
    pub fn get_admin(env: Env) -> Address {
        get_admin(&env)
    }

    /// Returns the surety admin address.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// The `Address` of the surety.
    pub fn get_surety(env: Env) -> Address {
        get_surety(&env)
    }

    /// Returns the SAC token address used for collateral.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// The `Address` of the token.
    pub fn get_token(env: Env) -> Address {
        get_token(&env)
    }

    /// Returns the oracle admin address.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// The `Address` of the oracle admin.
    pub fn get_oracle_admin(env: Env) -> Address {
        get_oracle_admin(&env)
    }

    /// Rotates the oracle admin address.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `caller`: The admin address initiating the rotation.
    /// - `new_oracle_admin`: The new oracle admin address.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    pub fn rotate_oracle_admin(env: Env, caller: Address, new_oracle_admin: Address) {
        require_admin(&env, &caller);
        caller.require_auth();
        new_oracle_admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::OracleAdmin, &new_oracle_admin);
        env.events()
            .publish((symbol_short!("oraclrot"), new_oracle_admin.clone()), ());
    }

    /// Transfers the platform admin role to a new address.
    ///
    /// The current admin must authorize the call.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `new_admin`: The new platform admin address.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let old_admin = get_admin(&env);
        old_admin.require_auth();

        // Build a single-element admins vec and overwrite storage.
        let mut new_admins: Vec<Address> = Vec::new(&env);
        new_admins.push_back(new_admin.clone());
        env.storage().instance().set(&DataKey::Admins, &new_admins);

        env.events().publish(
            (Symbol::new(&env, "admin_transferred"), old_admin.clone()),
            (old_admin, new_admin, env.ledger().timestamp()),
        );
    }

    /// Migrates an importer's account state to a new `Account` structure.
    ///
    /// Must be authorized by a platform administrator.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `admin`: The admin address authorizing the migration.
    /// - `importer`: The Stellar address of the importer.
    /// - `new_account`: The new `Account` state.
    ///
    /// # Panics
    /// - `Error::NotAnAdmin`: If the caller is not a platform admin.
    pub fn migrate_account(env: Env, admin: Address, importer: Address, new_account: Account) {
        require_admin(&env, &admin);
        admin.require_auth();
        save_account(&env, &importer, &new_account);
        env.events().publish(
            (symbol_short!("migrat"), importer.clone()),
            new_account.bond_id,
        );
    }

    /// Sets the price oracle contract address.
    ///
    /// Must be authorized by the platform admin.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `oracle`: The Stellar address of the price oracle.
    pub fn set_price_oracle(env: Env, oracle: Address) {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::PriceOracle, &oracle);
        env.events()
            .publish((symbol_short!("oracle"), oracle.clone()), ());
    }

    /// Returns the optional price oracle contract address.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    ///
    /// # Returns
    /// The `Option<Address>` of the price oracle if set.
    pub fn get_price_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PriceOracle)
    }

    /// Upgrades the contract WASM bytecode.
    ///
    /// Must be authorized by the platform admin.
    ///
    /// # Parameters
    /// - `env`: The Soroban execution environment.
    /// - `new_wasm_hash`: The WASM hash of the new contract code.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = get_admin(&env);
        admin.require_auth();
        let old_version = env
            .storage()
            .instance()
            .get::<_, Symbol>(&DataKey::Version)
            .unwrap_or_else(|| symbol_short!("v0_2_0"));
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        let new_version = symbol_short!("v0_3_0");
        env.storage()
            .instance()
            .set(&DataKey::Version, &new_version);
        env.events().publish(
            (symbol_short!("upgrade"), new_wasm_hash),
            (old_version, new_version, env.ledger().timestamp()),
        );
    }

    /// Returns the current contract version symbol.
    ///
    /// # Returns
    /// The contract version `Symbol`.
    pub fn version() -> Symbol {
        symbol_short!("v0_3_0")
    }
}

/// Retrieves the primary platform administrator address from instance storage.
fn get_admin(env: &Env) -> Address {
    let admins: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Admins)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    admins.get(0).unwrap()
}

/// Asserts that the specified address is an authorized platform administrator.
fn require_admin(env: &Env, caller: &Address) {
    let admins: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Admins)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    if !admins.contains(caller.clone()) {
        panic_with_error!(env, Error::NotAnAdmin);
    }
}

/// Retrieves the surety administrator address from instance storage.
fn get_surety(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Surety)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Retrieves the SAC token contract address from instance storage.
fn get_token(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Loads the account state of a registered importer from persistent storage.
fn load_account(env: &Env, importer: &Address) -> Account {
    env.storage()
        .persistent()
        .get(&DataKey::Account(importer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::ImporterNotRegistered))
}

/// Saves the account state of a registered importer to persistent storage.
fn save_account(env: &Env, importer: &Address, acct: &Account) {
    env.storage()
        .persistent()
        .set(&DataKey::Account(importer.clone()), acct);
}

/// Asserts that the importer's account is active and has not been clawed back.
fn require_active(env: &Env, acct: &Account) {
    if acct.is_clawbacked {
        panic_with_error!(env, Error::AccountFrozen);
    }
}

/// Checks if the importer's account state is stale (older than 365 days).
fn is_stale(env: &Env, acct: &Account) -> bool {
    env.ledger().timestamp() > acct.collateral_last_updated + 365 * 86400
}

/// Asserts that the importer's account state is fresh (not stale).
fn require_fresh_collateral(env: &Env, importer: &Address, acct: &Account) {
    if is_stale(env, acct) {
        let expiry = acct.collateral_last_updated + 365 * 86400;
        env.events()
            .publish((symbol_short!("stale"), importer.clone()), expiry);
        panic_with_error!(env, Error::StaleOracleError);
    }
}

/// Retrieves the oracle administrator address from instance storage.
fn get_oracle_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::OracleAdmin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Retrieves the emergency oracle administrator address from instance storage.
fn get_emergency_oracle_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::EmergencyOracleAdmin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Retrieves the optional price oracle address from instance storage.
fn get_price_oracle_optional(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PriceOracle)
}

/// Invokes the external price oracle contract to fetch the current USDC/USD rate.
fn get_usdc_usd_rate(env: &Env, oracle: &Address) -> i128 {
    let rate: i128 = env.invoke_contract(
        oracle,
        &Symbol::new(env, "get_usdc_usd_rate"),
        soroban_sdk::Vec::new(env),
    );
    rate
}

/// Returns the required collateral value currently in force (respects active disputes).
fn effective_required(acct: &Account) -> i128 {
    if acct.dispute_raised {
        acct.pre_dispute_required
    } else {
        acct.required_collateral
    }
}
