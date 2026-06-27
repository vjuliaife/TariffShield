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
    contract, contractimpl, contracttype, panic_with_error, symbol_short, token, Address, BytesN, Env,
    Symbol, Vec,
};

mod errors;
mod test;

pub use errors::Error;

#[contract]
pub struct TariffShieldContract;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admins,
    Surety,
    Token,
    Account(Address),
    Proposal(u64),
    ProposalCounter,
    PriceOracle,
    Version,
    // #339 — dedicated oracle role; can set_required_collateral but not upgrade/register
    OracleAdmin,
    EmergencyOracleAdmin,
    HasUpdated(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub new_wasm_hash: BytesN<32>,
    pub approvals: Vec<Address>,
    pub expiry_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Account {
    pub bond_id: u64,
    pub collateral_balance: i128,
    pub required_collateral: i128,
    pub reserve_balance: i128,
    pub yield_accrued: i128,
    pub is_clawbacked: bool,
    pub collateral_last_updated: u64,
}

#[contractimpl]
impl TariffShieldContract {
    /// #339 — `oracle_admin` is required auth; set to same as admins[0] if not separate.
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
        env.storage().instance().set(&DataKey::OracleAdmin, &oracle_admin);
        env.storage().instance().set(&DataKey::EmergencyOracleAdmin, &emergency_oracle_admin);
        env.storage().instance().set(&DataKey::ProposalCounter, &0u64);
    }

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
            collateral_last_updated: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &account);
        env.events().publish(
            (symbol_short!("registr"), importer.clone()),
            (bond_id, required_collateral),
        );
    }

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

        let cooldown_seconds: u64 = 86400;
        let has_updated_key = DataKey::HasUpdated(importer.clone());
        let has_been_updated = env.storage().persistent().has(&has_updated_key);
        if !bypass_rate_limit && !emergency && has_been_updated && acct.collateral_last_updated > 0 {
            if current_timestamp < acct.collateral_last_updated + cooldown_seconds {
                let retry_after = acct.collateral_last_updated + cooldown_seconds;
                env.events().publish(
                    (symbol_short!("ratelimit"), importer.clone()),
                    retry_after,
                );
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
            env.events().publish(
                (symbol_short!("depeg"), importer.clone()),
                oracle_rate,
            );
        }

        let old_required = acct.required_collateral;
        acct.required_collateral = adjusted_required;
        acct.collateral_last_updated = current_timestamp;
        save_account(&env, &importer, &acct);
        env.storage().persistent().set(&has_updated_key, &true);
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

    pub fn auto_top_up(env: Env, importer: Address) -> i128 {
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        let shortfall = acct.required_collateral - acct.collateral_balance;
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

    pub fn withdraw_collateral(env: Env, importer: Address, to: Address, amount: i128) {
        importer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        require_active(&env, &acct);
        require_fresh_collateral(&env, &importer, &acct);
        let excess = acct.collateral_balance - acct.required_collateral;
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

    pub fn propose_upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> u64 {
        require_admin(&env, &caller);
        caller.require_auth();

        let counter: u64 = env.storage().instance().get(&DataKey::ProposalCounter).unwrap_or(0);
        let proposal_id = counter + 1;
        env.storage().instance().set(&DataKey::ProposalCounter, &proposal_id);

        let mut approvals = Vec::new(&env);
        approvals.push_back(caller.clone());

        let expiry_ledger = env.ledger().sequence() + 17280; // ~1 day at 5s/ledger

        let proposal = Proposal {
            new_wasm_hash,
            approvals,
            expiry_ledger,
        };
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        proposal_id
    }

    pub fn approve_upgrade(env: Env, caller: Address, proposal_id: u64) {
        require_admin(&env, &caller);
        caller.require_auth();

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env.storage().persistent().get(&key).unwrap_or_else(|| {
            panic_with_error!(&env, Error::ProposalNotFound)
        });

        if env.ledger().sequence() > proposal.expiry_ledger {
            env.storage().persistent().remove(&key);
            panic_with_error!(&env, Error::ProposalExpired);
        }

        if proposal.approvals.contains(caller.clone()) {
            panic_with_error!(&env, Error::AlreadyVoted);
        }

        proposal.approvals.push_back(caller);

        if proposal.approvals.len() >= 2 {
            env.deployer().update_current_contract_wasm(proposal.new_wasm_hash);
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &proposal);
        }
    }

    pub fn cancel_upgrade(env: Env, caller: Address, proposal_id: u64) {
        require_admin(&env, &caller);
        caller.require_auth();

        let key = DataKey::Proposal(proposal_id);
        if !env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::ProposalNotFound);
        }
        env.storage().persistent().remove(&key);
    }

    pub fn get_account(env: Env, importer: Address) -> Account {
        load_account(&env, &importer)
    }

    pub fn is_collateral_stale(env: Env, account_id: Address) -> bool {
        let acct = load_account(&env, &account_id);
        is_stale(&env, &acct)
    }

    pub fn get_admin(env: Env) -> Address {
        get_admin(&env)
    }
    pub fn get_surety(env: Env) -> Address {
        get_surety(&env)
    }
    pub fn get_token(env: Env) -> Address {
        get_token(&env)
    }

    // #339 — view the current oracle admin address
    pub fn get_oracle_admin(env: Env) -> Address {
        get_oracle_admin(&env)
    }

    // #339 — general admin can rotate the oracle admin key (e.g. after compromise)
    pub fn rotate_oracle_admin(env: Env, caller: Address, new_oracle_admin: Address) {
        require_admin(&env, &caller);
        caller.require_auth();
        new_oracle_admin.require_auth();
        env.storage().instance().set(&DataKey::OracleAdmin, &new_oracle_admin);
        env.events().publish(
            (symbol_short!("oraclrot"), new_oracle_admin.clone()),
            (),
        );
    }

    pub fn migrate_account(env: Env, admin: Address, importer: Address, new_account: Account) {
        require_admin(&env, &admin);
        admin.require_auth();
        save_account(&env, &importer, &new_account);
        env.events().publish(
            (symbol_short!("migrat"), importer.clone()),
            new_account.bond_id,
        );
    }

    pub fn set_price_oracle(env: Env, oracle: Address) {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::PriceOracle, &oracle);
        env.events().publish((symbol_short!("oracle"), oracle.clone()), ());
    }

    pub fn get_price_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PriceOracle)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = get_admin(&env);
        admin.require_auth();
        let old_version = env.storage()
            .instance()
            .get::<_, Symbol>(&DataKey::Version)
            .unwrap_or_else(|| symbol_short!("v0_2_0"));
        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());
        let new_version = symbol_short!("v0_3_0");
        env.storage().instance().set(&DataKey::Version, &new_version);
        env.events().publish(
            (symbol_short!("upgrade"), new_wasm_hash),
            (old_version, new_version, env.ledger().timestamp()),
        );
    }

    pub fn version() -> Symbol {
        symbol_short!("v0_3_0")
    }
}

fn get_admin(env: &Env) -> Address {
    let admins: Vec<Address> = env.storage()
        .instance()
        .get(&DataKey::Admins)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    admins.get(0).unwrap()
}

fn require_admin(env: &Env, caller: &Address) {
    let admins: Vec<Address> = env.storage()
        .instance()
        .get(&DataKey::Admins)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    if !admins.contains(caller.clone()) {
        panic_with_error!(env, Error::NotAnAdmin);
    }
}

fn get_surety(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Surety)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn get_token(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn load_account(env: &Env, importer: &Address) -> Account {
    env.storage()
        .persistent()
        .get(&DataKey::Account(importer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::ImporterNotRegistered))
}

fn save_account(env: &Env, importer: &Address, acct: &Account) {
    env.storage()
        .persistent()
        .set(&DataKey::Account(importer.clone()), acct);
}

fn require_active(env: &Env, acct: &Account) {
    if acct.is_clawbacked {
        panic_with_error!(env, Error::AccountFrozen);
    }
}

fn is_stale(env: &Env, acct: &Account) -> bool {
    env.ledger().timestamp() > acct.collateral_last_updated + 365 * 86400
}

fn require_fresh_collateral(env: &Env, importer: &Address, acct: &Account) {
    if is_stale(env, acct) {
        let expiry = acct.collateral_last_updated + 365 * 86400;
        env.events().publish((symbol_short!("stale"), importer.clone()), expiry);
        panic_with_error!(env, Error::StaleOracleError);
    }
}

fn get_oracle_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::OracleAdmin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn get_emergency_oracle_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::EmergencyOracleAdmin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn get_price_oracle_optional(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PriceOracle)
}

fn get_usdc_usd_rate(env: &Env, oracle: &Address) -> i128 {
    let rate: i128 = env
        .invoke_contract(
            oracle,
            &Symbol::new(env, "get_usdc_usd_rate"),
            soroban_sdk::Vec::new(env),
        );
    rate
}

