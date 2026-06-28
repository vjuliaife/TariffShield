#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Env, IntoVal,
};

struct Setup<'a> {
    env: Env,
    contract_id: Address,
    client: TariffShieldContractClient<'a>,
    admin1: Address,
    admin2: Address,
    admin3: Address,
    oracle_admin: Address,
    surety: Address,
    importer: Address,
    funder: Address,
    token: TokenClient<'a>,
    token_admin: StellarAssetClient<'a>,
    token_addr: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let oracle_admin = Address::generate(&env);
    let surety = Address::generate(&env);
    let importer = Address::generate(&env);
    let funder = Address::generate(&env);
    let token_admin_addr = Address::generate(&env);

    let token_sac = env.register_stellar_asset_contract_v2(token_admin_addr.clone());
    let token_addr = token_sac.address();
    let token = TokenClient::new(&env, &token_addr);
    let token_admin = StellarAssetClient::new(&env, &token_addr);

    token_admin.mint(&funder, &1_000_000_0000000);
    token_admin.mint(&importer, &500_000_0000000);

    let contract_id = env.register(TariffShieldContract, ());
    let client = TariffShieldContractClient::new(&env, &contract_id);

    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.initialize(&admins, &surety, &token_addr, &oracle_admin);

    Setup {
        env,
        contract_id,
        client,
        admin1,
        admin2,
        admin3,
        oracle_admin,
        surety,
        importer,
        funder,
        token,
        token_admin,
        token_addr,
    }
}

#[test]
fn initialize_sets_admin_surety_token() {
    let s = setup();
    assert_eq!(s.client.get_admin(), s.admin1);
    assert_eq!(s.client.get_surety(), s.surety);
    assert_eq!(s.client.get_token(), s.token_addr);
    assert_eq!(s.client.get_oracle_admin(), s.oracle_admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn cannot_initialize_twice() {
    let s = setup();
    let mut admins = soroban_sdk::Vec::new(&s.env);
    admins.push_back(s.admin1.clone());
    s.client.initialize(&admins, &s.surety, &s.token_addr, &s.oracle_admin);
}

#[test]
fn register_importer_creates_zero_balance_account() {
    let s = setup();
    s.client.register_importer(&s.importer, &42, &100_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.bond_id, 42);
    assert_eq!(acct.collateral_balance, 0);
    assert_eq!(acct.required_collateral, 100_000_0000000);
    assert_eq!(acct.reserve_balance, 0);
    assert_eq!(acct.is_clawbacked, false);
    assert_eq!(acct.oracle_last_updated, 0);
    assert_eq!(acct.dispute_raised, false);
}

#[test]
fn deposit_collateral_transfers_token_and_updates_balance() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    let funder_before = s.token.balance(&s.funder);
    s.client.deposit_collateral(&s.importer, &s.funder, &50_000_0000000);

    assert_eq!(s.token.balance(&s.funder), funder_before - 50_000_0000000);
    assert_eq!(s.token.balance(&s.contract_id), 50_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
}

#[test]
fn deposit_reserve_credits_reserve_bucket() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &30_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.reserve_balance, 30_000_0000000);
    assert_eq!(acct.collateral_balance, 0);
}

#[test]
fn auto_top_up_moves_reserve_to_collateral_up_to_shortfall() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &50_000_0000000);

    let moved = s.client.auto_top_up(&s.importer);
    assert_eq!(moved, 40_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 100_000_0000000);
    assert_eq!(acct.reserve_balance, 10_000_0000000);
}

#[test]
fn auto_top_up_is_zero_when_collateral_already_meets_required() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &10_000_0000000);

    assert_eq!(s.client.auto_top_up(&s.importer), 0);
}

#[test]
fn auto_top_up_uses_partial_reserve_when_reserve_insufficient() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &20_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &30_000_0000000);

    let moved = s.client.auto_top_up(&s.importer);
    assert_eq!(moved, 30_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
    assert_eq!(acct.reserve_balance, 0);
}

#[test]
fn set_required_collateral_updates_target() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    s.client.set_required_collateral(&s.importer, &175_000_0000000, &None, &false);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 175_000_0000000);
}

#[test]
fn withdraw_collateral_succeeds_when_collateral_above_required() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &80_000_0000000);

    s.client.withdraw_collateral(&s.importer, &s.importer, &20_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 60_000_0000000);
    assert_eq!(s.token.balance(&s.importer), 500_000_0000000 + 20_000_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn withdraw_collateral_fails_when_would_breach_required() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client.withdraw_collateral(&s.importer, &s.importer, &20_000_0000000);
}

#[test]
fn accrue_yield_increments_yield_accrued() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.accrue_yield(&s.importer, &123_4567);
    s.client.accrue_yield(&s.importer, &500_0000);
    assert_eq!(s.client.get_account(&s.importer).yield_accrued, 623_4567);
}

#[test]
fn clawback_drains_buckets_to_surety_and_freezes_account() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &40_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &15_000_0000000);

    let surety_before = s.token.balance(&s.surety);
    let taken = s.client.clawback(&s.importer);

    assert_eq!(taken, 55_000_0000000);
    assert_eq!(s.token.balance(&s.surety), surety_before + 55_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 0);
    assert_eq!(acct.reserve_balance, 0);
    assert_eq!(acct.is_clawbacked, true);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn deposit_after_clawback_is_rejected() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.clawback(&s.importer);
    s.client.deposit_collateral(&s.importer, &s.funder, &1_0000000);
}

#[test]
#[should_panic(expected = "Error(Storage, MissingValue)")]
fn propose_and_approve_upgrade() {
    let s = setup();
    let hash = soroban_sdk::BytesN::from_array(&s.env, &[1; 32]);
    let proposal_id = s.client.propose_upgrade(&s.admin1, &hash);

    // Admin 2 approves
    s.client.approve_upgrade(&s.admin2, &proposal_id);

    // We expect the contract to have called `update_current_contract_wasm`
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn cancel_upgrade_removes_proposal() {
    let s = setup();
    let hash = soroban_sdk::BytesN::from_array(&s.env, &[1; 32]);
    let proposal_id = s.client.propose_upgrade(&s.admin1, &hash);

    s.client.cancel_upgrade(&s.admin1, &proposal_id);
    s.client.approve_upgrade(&s.admin3, &proposal_id); // Should panic (ProposalNotFound)
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn cannot_approve_twice() {
    let s = setup();
    let hash = soroban_sdk::BytesN::from_array(&s.env, &[1; 32]);
    let proposal_id = s.client.propose_upgrade(&s.admin1, &hash);

    s.client.approve_upgrade(&s.admin1, &proposal_id);
}

#[test]
fn staleness_checks_work() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    assert_eq!(s.client.is_collateral_stale(&s.importer), false);

    // fast forward 366 days
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100 + 366 * 86400;
    });
    assert_eq!(s.client.is_collateral_stale(&s.importer), true);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // StaleOracleError
fn stale_collateral_blocks_deposit() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    // Fast forward 366 days
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100 + 366 * 86400;
    });

    s.client.deposit_collateral(&s.importer, &s.funder, &1_0000000);
}

// ── Rate-limit tests ───────────────────────────────────────────────────────────
// oracle_last_updated starts at 0 after registration, so the first oracle update
// is always allowed regardless of current timestamp.

#[test]
fn rate_limit_first_update_allowed() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    s.client.set_required_collateral(&s.importer, &150_000_0000000, &None, &false);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 150_000_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")] // RateLimitExceededError
fn rate_limit_blocks_second_update_within_24h() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(&s.importer, &150_000_0000000, &None, &false);

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 43200;
    });

    s.client.set_required_collateral(&s.importer, &175_000_0000000, &None, &false);
}

#[test]
fn rate_limit_allows_update_after_24h() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(&s.importer, &150_000_0000000, &None, &false);

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 86400;
    });

    s.client.set_required_collateral(&s.importer, &175_000_0000000, &None, &false);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 175_000_0000000);
}

#[test]
fn rate_limit_emergency_bypass_overrides_cooldown() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(&s.importer, &150_000_0000000, &None, &false);

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 43200;
    });

    s.client.set_required_collateral(&s.importer, &175_000_0000000, &None, &true);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 175_000_0000000);
}

#[test]
fn upgrade_entrypoint_updates_wasm_and_version() {
    let s = setup();
    let hash = soroban_sdk::BytesN::from_array(&s.env, &[42; 32]);
    s.client.upgrade(&hash);
}

#[test]
fn set_and_get_price_oracle() {
    let s = setup();
    let oracle = Address::generate(&s.env);
    s.client.set_price_oracle(&oracle);
    assert_eq!(s.client.get_price_oracle().unwrap(), oracle);
}

// ── #326: 5× single-update increase cap ───────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // CollateralCapExceeded
fn set_required_collateral_rejects_more_than_5x_increase() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    // 501k is more than 5× the registered 100k
    s.client.set_required_collateral(&s.importer, &501_000_0000000, &None, &false);
}

#[test]
fn set_required_collateral_allows_exactly_5x_increase() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &100_000_0000000);
    // Exactly 5× (500k) is allowed
    s.client.set_required_collateral(&s.importer, &500_000_0000000, &None, &false);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 500_000_0000000);
}

#[test]
fn set_required_collateral_allows_decrease_beyond_5x() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &500_000_0000000);
    // Decreases are uncapped — oracle can always lower the requirement
    s.client.set_required_collateral(&s.importer, &10_000_0000000, &None, &false);
    assert_eq!(s.client.get_account(&s.importer).required_collateral, 10_000_0000000);
}

// ── #331: on-chain collateral history ─────────────────────────────────────────

#[test]
fn collateral_history_records_changes() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &100_000_0000000);

    // First oracle update — records the old value (100k) in history
    s.client.set_required_collateral(&s.importer, &200_000_0000000, &None, &false);

    s.env.ledger().with_mut(|li| { li.timestamp = 1000 + 86400; });

    // Second oracle update — records previous value (200k) in history
    s.client.set_required_collateral(&s.importer, &300_000_0000000, &None, &false);

    let history = s.client.get_collateral_history(&s.importer);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().value, 100_000_0000000);
    assert_eq!(history.get(0).unwrap().timestamp, 1000);
    assert_eq!(history.get(1).unwrap().value, 200_000_0000000);
    assert_eq!(history.get(1).unwrap().timestamp, 1000 + 86400);
}

#[test]
fn collateral_history_caps_at_12_entries() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 0; });
    s.client.register_importer(&s.importer, &1, &10_000_0000000);

    // Make 13 updates; each successive value is well within the 5× cap
    for i in 1u64..=13 {
        s.env.ledger().with_mut(|li| {
            li.timestamp = i * 86400;
        });
        let new_val = (10_000_0000000i128) + (i as i128) * 1_000_0000000;
        s.client.set_required_collateral(&s.importer, &new_val, &None, &false);
    }

    let history = s.client.get_collateral_history(&s.importer);
    // Only the last 12 entries are kept
    assert_eq!(history.len(), 12);
}

// ── #336: 72-hour dispute window ──────────────────────────────────────────────

#[test]
fn raise_dispute_suspends_enforcement_of_new_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &60_000_0000000);

    // Oracle raises requirement to 80k — opens a dispute window
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);

    // Importer formally disputes (still within 72h window at ts=1000)
    s.client.raise_dispute(&s.importer);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.dispute_raised, true);

    // During dispute pre_dispute_required (50k) is enforced.
    // collateral=60k, effective_required=50k → excess=10k; withdrawal should succeed.
    s.client.withdraw_collateral(&s.importer, &s.importer, &10_000_0000000);
    assert_eq!(s.client.get_account(&s.importer).collateral_balance, 50_000_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // CollateralBelowRequired
fn without_dispute_new_required_is_enforced() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.deposit_collateral(&s.importer, &s.funder, &60_000_0000000);

    // Oracle raises required to 80k; no dispute raised
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);

    // collateral=60k < required=80k → any withdrawal should fail
    s.client.withdraw_collateral(&s.importer, &s.importer, &10_000_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // NoDisputeWindow
fn raise_dispute_fails_outside_window() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);

    // Oracle updates at ts=1000, window closes at ts=1000+72*3600
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);

    // Fast-forward past the 72-hour window
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 72 * 3600 + 1;
    });

    s.client.raise_dispute(&s.importer);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")] // DisputeAlreadyRaised
fn raise_dispute_fails_when_already_raised() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);
    s.client.raise_dispute(&s.importer);
    s.client.raise_dispute(&s.importer); // second raise should fail
}

#[test]
fn resolve_dispute_accepted_keeps_new_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);
    s.client.raise_dispute(&s.importer);

    // Admin accepts the new value
    s.client.resolve_dispute(&s.importer, &true);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.required_collateral, 80_000_0000000);
    assert_eq!(acct.dispute_raised, false);
    assert_eq!(acct.dispute_expires_at, 0);
}

#[test]
fn resolve_dispute_rejected_reverts_to_old_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);
    s.client.raise_dispute(&s.importer);

    // Admin rejects — reverts to the pre-dispute value
    s.client.resolve_dispute(&s.importer, &false);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.required_collateral, 50_000_0000000);
    assert_eq!(acct.dispute_raised, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // NoActiveDispute
fn resolve_dispute_fails_when_no_dispute_raised() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.resolve_dispute(&s.importer, &true); // no dispute open
}

#[test]
fn auto_top_up_during_dispute_uses_pre_dispute_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| { li.timestamp = 1000; });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    // Importer has 30k collateral, 30k reserve
    s.client.deposit_collateral(&s.importer, &s.funder, &30_000_0000000);
    s.client.deposit_reserve(&s.importer, &s.funder, &30_000_0000000);

    // Oracle raises to 80k; importer disputes
    s.client.set_required_collateral(&s.importer, &80_000_0000000, &None, &false);
    s.client.raise_dispute(&s.importer);

    // auto_top_up should only move enough to reach pre_dispute (50k), not the new 80k.
    // shortfall to 50k = 20k; reserve=30k; moved=20k.
    let moved = s.client.auto_top_up(&s.importer);
    assert_eq!(moved, 20_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
    assert_eq!(acct.reserve_balance, 10_000_0000000);
}
