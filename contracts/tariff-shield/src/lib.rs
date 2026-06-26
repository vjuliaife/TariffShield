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
    pub fn initialize(env: Env, admins: Vec<Address>, surety: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Admins) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        for admin in admins.iter() {
            admin.require_auth();
        }
        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage().instance().set(&DataKey::Surety, &surety);
        env.storage().instance().set(&DataKey::Token, &token);
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

    pub fn set_required_collateral(env: Env, importer: Address, new_required: i128) {
        let admin = get_admin(&env);
        admin.require_auth();
        if new_required < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut acct = load_account(&env, &importer);
        let old_required = acct.required_collateral;
        acct.required_collateral = new_required;
        acct.collateral_last_updated = env.ledger().timestamp();
        save_account(&env, &importer, &acct);
        env.events().publish(
            (symbol_short!("required"), importer.clone()),
            (old_required, new_required),
        );
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

    pub fn version() -> Symbol {
        symbol_short!("v0_1_0")
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

