#![cfg(test)]
// Amounts are grouped as `<whole>_<7-decimal-stroops>` (e.g. `1_000_000_0000000`
// = 1,000,000.0000000) to keep the token's 7-decimal-place precision visible,
// rather than clippy's uniform 3-digit grouping.
#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    xdr::ToXdr,
    Env, IntoVal,
};
use std::time::Instant;

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
    _token_admin: StellarAssetClient<'a>,
    token_addr: Address,
    emergency_oracle_admin: Address,
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

    let emergency_oracle_admin = Address::generate(&env);
    client.initialize(
        &admins,
        &surety,
        &token_addr,
        &oracle_admin,
        &emergency_oracle_admin,
    );

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
        _token_admin: token_admin,
        token_addr,
        emergency_oracle_admin,
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
    s.client.initialize(
        &admins,
        &s.surety,
        &s.token_addr,
        &s.oracle_admin,
        &s.emergency_oracle_admin,
    );
}

#[test]
fn register_importer_creates_zero_balance_account() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &42, &100_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.bond_id, 42);
    assert_eq!(acct.collateral_balance, 0);
    assert_eq!(acct.required_collateral, 100_000_0000000);
    assert_eq!(acct.reserve_balance, 0);
    assert!(!acct.is_clawbacked);
    assert_eq!(acct.oracle_last_updated, 0);
    assert!(!acct.dispute_raised);
}

#[test]
fn deposit_collateral_transfers_token_and_updates_balance() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    let funder_before = s.token.balance(&s.funder);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &50_000_0000000);

    assert_eq!(s.token.balance(&s.funder), funder_before - 50_000_0000000);
    assert_eq!(s.token.balance(&s.contract_id), 50_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
}

#[test]
fn deposit_reserve_credits_reserve_bucket() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &30_000_0000000);
    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.reserve_balance, 30_000_0000000);
    assert_eq!(acct.collateral_balance, 0);
}

#[test]
fn auto_top_up_moves_reserve_to_collateral_up_to_shortfall() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &50_000_0000000);

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
    s.client
        .deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &10_000_0000000);

    assert_eq!(s.client.auto_top_up(&s.importer), 0);
}

#[test]
fn auto_top_up_uses_partial_reserve_when_reserve_insufficient() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &20_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &30_000_0000000);

    let moved = s.client.auto_top_up(&s.importer);
    assert_eq!(moved, 30_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
    assert_eq!(acct.reserve_balance, 0);
}

#[test]
fn set_required_collateral_updates_target() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &175_000_0000000,
        &None,
        &false,
        &false,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        175_000_0000000
    );
}

#[test]
fn withdraw_collateral_succeeds_when_collateral_above_required() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &80_000_0000000);

    s.client
        .withdraw_collateral(&s.importer, &s.importer, &20_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 60_000_0000000);
    assert_eq!(
        s.token.balance(&s.importer),
        500_000_0000000 + 20_000_0000000
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn withdraw_collateral_fails_when_would_breach_required() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &60_000_0000000);
    s.client
        .withdraw_collateral(&s.importer, &s.importer, &20_000_0000000);
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
    s.client
        .deposit_collateral(&s.importer, &s.funder, &40_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &15_000_0000000);

    let surety_before = s.token.balance(&s.surety);
    let taken = s.client.clawback(&s.importer);

    assert_eq!(taken, 55_000_0000000);
    assert_eq!(s.token.balance(&s.surety), surety_before + 55_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 0);
    assert_eq!(acct.reserve_balance, 0);
    assert!(acct.is_clawbacked);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn deposit_after_clawback_is_rejected() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.clawback(&s.importer);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &1_0000000);
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
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    assert!(!s.client.is_collateral_stale(&s.importer));

    // fast forward 366 days
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100 + 366 * 86400;
    });
    assert!(s.client.is_collateral_stale(&s.importer));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // StaleOracleError
fn stale_collateral_blocks_deposit() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100;
    });
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    // Fast forward 366 days
    s.env.ledger().with_mut(|li| {
        li.timestamp = 100 + 366 * 86400;
    });

    s.client
        .deposit_collateral(&s.importer, &s.funder, &1_0000000);
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
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &150_000_0000000,
        &None,
        &false,
        &false,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        150_000_0000000
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")] // RateLimitExceededError
fn rate_limit_blocks_second_update_within_24h() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &150_000_0000000,
        &None,
        &false,
        &false,
    );

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 43200;
    });

    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &175_000_0000000,
        &None,
        &false,
        &false,
    );
}

#[test]
fn rate_limit_allows_update_after_24h() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &150_000_0000000,
        &None,
        &false,
        &false,
    );

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 86400;
    });

    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &175_000_0000000,
        &None,
        &false,
        &false,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        175_000_0000000
    );
}

#[test]
fn rate_limit_emergency_bypass_overrides_cooldown() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &150_000_0000000,
        &None,
        &false,
        &false,
    );

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 43200;
    });

    s.client.set_required_collateral(
        &s.emergency_oracle_admin,
        &s.importer,
        &175_000_0000000,
        &None,
        &false,
        &true,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        175_000_0000000
    );
}

#[test]
#[should_panic(expected = "Error(Storage, MissingValue)")]
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
#[should_panic(expected = "Error(Contract, #17)")] // CollateralCapExceeded
fn set_required_collateral_rejects_more_than_5x_increase() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    // 501k is more than 5× the registered 100k
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &501_000_0000000,
        &None,
        &false,
        &false,
    );
}

#[test]
fn set_required_collateral_allows_exactly_5x_increase() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);
    // Exactly 5× (500k) is allowed
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &500_000_0000000,
        &None,
        &false,
        &false,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        500_000_0000000
    );
}

#[test]
fn set_required_collateral_allows_decrease_beyond_5x() {
    let s = setup();
    s.client
        .register_importer(&s.importer, &1, &500_000_0000000);
    // Decreases are uncapped — oracle can always lower the requirement
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &10_000_0000000,
        &None,
        &false,
        &false,
    );
    assert_eq!(
        s.client.get_account(&s.importer).required_collateral,
        10_000_0000000
    );
}

// ── #331: on-chain collateral history ─────────────────────────────────────────

#[test]
fn collateral_history_records_changes() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client
        .register_importer(&s.importer, &1, &100_000_0000000);

    // First oracle update — records the old value (100k) in history
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &200_000_0000000,
        &None,
        &false,
        &false,
    );

    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 86400;
    });

    // Second oracle update — records previous value (200k) in history
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &300_000_0000000,
        &None,
        &false,
        &false,
    );

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
    s.env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });
    s.client.register_importer(&s.importer, &1, &10_000_0000000);

    // Make 13 updates; each successive value is well within the 5× cap
    for i in 1u64..=13 {
        s.env.ledger().with_mut(|li| {
            li.timestamp = i * 86400;
        });
        let new_val = (10_000_0000000i128) + (i as i128) * 1_000_0000000;
        s.client.set_required_collateral(
            &s.oracle_admin,
            &s.importer,
            &new_val,
            &None,
            &false,
            &false,
        );
    }

    let history = s.client.get_collateral_history(&s.importer);
    // Only the last 12 entries are kept
    assert_eq!(history.len(), 12);
}

// ── #336: 72-hour dispute window ──────────────────────────────────────────────

#[test]
fn raise_dispute_suspends_enforcement_of_new_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &60_000_0000000);

    // Oracle raises requirement to 80k — opens a dispute window
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );

    // Importer formally disputes (still within 72h window at ts=1000)
    s.client.raise_dispute(&s.importer);

    let acct = s.client.get_account(&s.importer);
    assert!(acct.dispute_raised);

    // During dispute pre_dispute_required (50k) is enforced.
    // collateral=60k, effective_required=50k → excess=10k; withdrawal should succeed.
    s.client
        .withdraw_collateral(&s.importer, &s.importer, &10_000_0000000);
    assert_eq!(
        s.client.get_account(&s.importer).collateral_balance,
        50_000_0000000
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // CollateralBelowRequired
fn without_dispute_new_required_is_enforced() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client
        .deposit_collateral(&s.importer, &s.funder, &60_000_0000000);

    // Oracle raises required to 80k; no dispute raised
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );

    // collateral=60k < required=80k → any withdrawal should fail
    s.client
        .withdraw_collateral(&s.importer, &s.importer, &10_000_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")] // NoDisputeWindow
fn raise_dispute_fails_outside_window() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);

    // Oracle updates at ts=1000, window closes at ts=1000+72*3600
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );

    // Fast-forward past the 72-hour window
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000 + 72 * 3600 + 1;
    });

    s.client.raise_dispute(&s.importer);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // DisputeAlreadyRaised
fn raise_dispute_fails_when_already_raised() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );
    s.client.raise_dispute(&s.importer);
    s.client.raise_dispute(&s.importer); // second raise should fail
}

#[test]
fn resolve_dispute_accepted_keeps_new_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );
    s.client.raise_dispute(&s.importer);

    // Admin accepts the new value
    s.client.resolve_dispute(&s.importer, &true);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.required_collateral, 80_000_0000000);
    assert!(!acct.dispute_raised);
    assert_eq!(acct.dispute_expires_at, 0);
}

#[test]
fn resolve_dispute_rejected_reverts_to_old_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );
    s.client.raise_dispute(&s.importer);

    // Admin rejects — reverts to the pre-dispute value
    s.client.resolve_dispute(&s.importer, &false);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.required_collateral, 50_000_0000000);
    assert!(!acct.dispute_raised);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")] // NoActiveDispute
fn resolve_dispute_fails_when_no_dispute_raised() {
    let s = setup();
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    s.client.resolve_dispute(&s.importer, &true); // no dispute open
}

#[test]
fn auto_top_up_during_dispute_uses_pre_dispute_required() {
    let s = setup();
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    s.client.register_importer(&s.importer, &1, &50_000_0000000);
    // Importer has 30k collateral, 30k reserve
    s.client
        .deposit_collateral(&s.importer, &s.funder, &30_000_0000000);
    s.client
        .deposit_reserve(&s.importer, &s.funder, &30_000_0000000);

    // Oracle raises to 80k; importer disputes
    s.client.set_required_collateral(
        &s.oracle_admin,
        &s.importer,
        &80_000_0000000,
        &None,
        &false,
        &false,
    );
    s.client.raise_dispute(&s.importer);

    // auto_top_up should only move enough to reach pre_dispute (50k), not the new 80k.
    // shortfall to 50k = 20k; reserve=30k; moved=20k.
    let moved = s.client.auto_top_up(&s.importer);
    assert_eq!(moved, 20_000_0000000);

    let acct = s.client.get_account(&s.importer);
    assert_eq!(acct.collateral_balance, 50_000_0000000);
    assert_eq!(acct.reserve_balance, 10_000_0000000);
}

// ── transfer_admin ─────────────────────────────────────────────────────────────

#[test]
fn transfer_admin_updates_admin_and_emits_event() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.transfer_admin(&new_admin);
    assert_eq!(s.client.get_admin(), new_admin);
}

/// A non-admin caller cannot invoke transfer_admin.
/// Uses mock_auths to authorize only the intruder — the real admin's require_auth() fails.
#[test]
#[should_panic]
fn non_admin_cannot_transfer_admin() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let surety = Address::generate(&env);
    let oracle_admin = Address::generate(&env);
    let emergency_oracle_admin = Address::generate(&env);
    let intruder = Address::generate(&env);
    let token_addr = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let contract_id = env.register(TariffShieldContract, ());
    let client = TariffShieldContractClient::new(&env, &contract_id);

    // Initialize under mock_all_auths so setup succeeds.
    env.mock_all_auths();
    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin.clone());
    client.initialize(
        &admins,
        &surety,
        &token_addr,
        &oracle_admin,
        &emergency_oracle_admin,
    );

    // Only authorize `intruder` for the transfer call.
    // admin.require_auth() inside transfer_admin will not be satisfied → panic.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &intruder,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_admin",
            args: soroban_sdk::vec![&env, intruder.clone().to_val()].into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.transfer_admin(&intruder);
}

fn benchmark_importer_batch(
    count: usize,
    action: impl Fn(&Setup<'_>, &Address),
) -> (u128, u64, u64) {
    let s = setup();
    let mut importers = std::vec::Vec::with_capacity(count);
    for _ in 0..count {
        importers.push(Address::generate(&s.env));
    }

    for (i, importer) in importers.iter().enumerate() {
        s.client
            .register_importer(importer, &(10_000 + i as u64), &100_000_0000000);
        s.client
            .deposit_collateral(importer, &s.funder, &10_000_0000);
        s.client.deposit_reserve(importer, &s.funder, &10_000_0000);
    }

    let mut budget = s.env.cost_estimate().budget();
    budget.reset_unlimited();
    budget.reset_tracker();

    let start = Instant::now();
    for importer in &importers {
        action(&s, importer);
    }
    let elapsed_ns = start.elapsed().as_nanos();
    (
        elapsed_ns,
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost(),
    )
}

#[test]
fn benchmark_bulk_enforcement_paths() {
    let clawback_one = benchmark_importer_batch(1, |s, importer| {
        let _ = s.client.clawback(importer);
    });
    let clawback_100 = benchmark_importer_batch(100, |s, importer| {
        let _ = s.client.clawback(importer);
    });
    let clawback_1000 = benchmark_importer_batch(1000, |s, importer| {
        let _ = s.client.clawback(importer);
    });

    let stale_100 = benchmark_importer_batch(100, |s, importer| {
        let _ = s.client.is_collateral_stale(importer);
    });
    let stale_1000 = benchmark_importer_batch(1000, |s, importer| {
        let _ = s.client.is_collateral_stale(importer);
    });

    let s = setup();
    let mut history_stats = std::vec::Vec::new();
    for entry_count in [10usize, 100, 1000] {
        let importer = Address::generate(&s.env);
        s.client.register_importer(
            &importer,
            &((entry_count as u64) + 20_000),
            &100_000_0000000,
        );
        for i in 0..entry_count {
            s.env.ledger().with_mut(|li| {
                li.timestamp = 1_000_000 + i as u64;
            });
            s.client.set_required_collateral(
                &s.emergency_oracle_admin,
                &importer,
                &((100_000_0000000i128) + (i as i128) * 1_000_0000),
                &None,
                &false,
                &true,
            );
        }
        let mut budget = s.env.cost_estimate().budget();
        budget.reset_unlimited();
        budget.reset_tracker();
        let start = Instant::now();
        let history = s.client.get_collateral_history(&importer);
        let encoded = history.to_xdr(&s.env);
        let elapsed_ns = start.elapsed().as_nanos();
        history_stats.push((
            entry_count as u64,
            elapsed_ns,
            budget.cpu_instruction_cost(),
            budget.memory_bytes_cost(),
            encoded.len() as u64,
        ));
    }

    let mut signer_stats = std::vec::Vec::new();
    for signer_count in [3usize, 5, 7] {
        let mut current_signers = soroban_sdk::Vec::new(&s.env);
        for _ in 0..signer_count {
            current_signers.push_back(Address::generate(&s.env));
        }
        s.env
            .storage()
            .instance()
            .set(&DataKey::OracleSigners, &current_signers);
        s.env
            .storage()
            .instance()
            .set(&DataKey::OracleThreshold, &2u32);

        let mut new_signers = soroban_sdk::Vec::new(&s.env);
        for _ in 0..3 {
            new_signers.push_back(Address::generate(&s.env));
        }
        let approvals = current_signers.clone();
        let mut budget = s.env.cost_estimate().budget();
        budget.reset_unlimited();
        budget.reset_tracker();
        let start = Instant::now();
        s.client.update_oracle_signers(&new_signers, &approvals);
        let elapsed_ns = start.elapsed().as_nanos();
        signer_stats.push((
            signer_count as u64,
            elapsed_ns,
            budget.cpu_instruction_cost(),
            budget.memory_bytes_cost(),
        ));
    }

    std::println!(
        "clawback: 1={:?} 100={:?} 1000={:?}",
        clawback_one,
        clawback_100,
        clawback_1000
    );
    std::println!("stale: 100={:?} 1000={:?}", stale_100, stale_1000);
    std::println!("history: {:?}", history_stats);
    std::println!("signers: {:?}", signer_stats);

    assert!(clawback_100.0 >= clawback_one.0);
    assert!(clawback_1000.0 >= clawback_100.0);
    assert!(stale_1000.0 >= stale_100.0);
}

#[test]
fn benchmark_register_importer_scaling() {
    let s = setup();
    let target_sizes = [100, 1000, 10000];
    let mut current_importers_count = 0;

    for size in target_sizes {
        s.env.as_contract(&s.contract_id, || {
            while current_importers_count < size {
                let importer = Address::generate(&s.env);
                let key = DataKey::Account(importer);
                let account = Account {
                    bond_id: current_importers_count as u64 + 50_000,
                    collateral_balance: 0,
                    required_collateral: 100_000_0000000,
                    reserve_balance: 0,
                    yield_accrued: 0,
                    is_clawbacked: false,
                    collateral_last_updated: s.env.ledger().timestamp(),
                    collateral_history: soroban_sdk::Vec::new(&s.env),
                    dispute_expires_at: 0,
                    pre_dispute_required: 100_000_0000000,
                    dispute_raised: false,
                    oracle_last_updated: 0,
                };
                s.env.storage().persistent().set(&key, &account);
                current_importers_count += 1;
            }
        });

        let next_importer = Address::generate(&s.env);
        let mut budget = s.env.cost_estimate().budget();
        budget.reset_unlimited();
        budget.reset_tracker();

        s.client.register_importer(
            &next_importer,
            &((current_importers_count as u64) + 50_000),
            &100_000_0000000,
        );

        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        std::println!(
            "REGISTER_IMPORTER_BENCHMARK: size={}, cpu={}, mem={}",
            size,
            cpu,
            mem
        );

        current_importers_count += 1;
    }
}

// #1127 — cost of a single `deposit_reserve` / `deposit_collateral` call after
// a varying number of *prior* deposits, to check whether the per-call resource
// cost grows with the importer's deposit history. Both functions load one
// fixed-size `DataKey::Account` entry, do a single SAC transfer, and `+=` one
// balance field before saving the same fixed-size entry — `collateral_history`
// is only appended to by `set_required_collateral`, never by deposits — so the
// measured cost is expected to be flat across prior-deposit counts.
enum DepositKind {
    Reserve,
    Collateral,
}

fn deposit_cost_after_prior_deposits(kind: &DepositKind, prior: usize) -> (u64, u64) {
    let s = setup();
    s.client
        .register_importer(&s.importer, &(900_000 + prior as u64), &1_000_000_0000000);

    let deposit = |s: &Setup, amount: i128| match kind {
        DepositKind::Reserve => s.client.deposit_reserve(&s.importer, &s.funder, &amount),
        DepositKind::Collateral => s.client.deposit_collateral(&s.importer, &s.funder, &amount),
    };

    for _ in 0..prior {
        deposit(&s, 500_0000); // 0.5 XLM each; 1000 priors = 500 XLM < funder's 1000 XLM
    }

    let mut budget = s.env.cost_estimate().budget();
    budget.reset_unlimited();
    budget.reset_tracker();
    deposit(&s, 1_000_0000); // the measured (prior+1)-th call
    (budget.cpu_instruction_cost(), budget.memory_bytes_cost())
}

// #1127 — isolates the *true* per-call cost from the cumulative test-env event
// log. The env is set up with one real deposit (to create the token ledger
// entries), then `prior` further deposits are simulated as plain Account-state
// rewrites under the same `DataKey::Account(importer)` key (the exact final
// state N sequential deposits would leave, minus the N published events). The
// measured call then sees a ledger whose account has {1, 100, 1000} prior
// deposit history with no host-side event accumulation.
fn deposit_cost_isolated(kind: &DepositKind, prior: usize) -> (u64, u64) {
    let s = setup();
    s.client
        .register_importer(&s.importer, &(800_000 + prior as u64), &1_000_000_0000000);

    match kind {
        DepositKind::Reserve => s.client.deposit_reserve(&s.importer, &s.funder, &1_000_0000),
        DepositKind::Collateral => s.client.deposit_collateral(&s.importer, &s.funder, &1_000_0000),
    }

    const PER_DEPOSIT: i128 = 1_000_0000;
    s.env.as_contract(&s.contract_id, || {
        let key = DataKey::Account(s.importer.clone());
        let mut acct: Account = s.env.storage().persistent().get(&key).unwrap();
        let total = PER_DEPOSIT * (prior as i128 + 1);
        match kind {
            DepositKind::Reserve => acct.reserve_balance = total,
            DepositKind::Collateral => acct.collateral_balance = total,
        }
        s.env.storage().persistent().set(&key, &acct);
    });

    let mut budget = s.env.cost_estimate().budget();
    budget.reset_unlimited();
    budget.reset_tracker();
    match kind {
        DepositKind::Reserve => s.client.deposit_reserve(&s.importer, &s.funder, &PER_DEPOSIT),
        DepositKind::Collateral => s.client.deposit_collateral(&s.importer, &s.funder, &PER_DEPOSIT),
    }
    (budget.cpu_instruction_cost(), budget.memory_bytes_cost())
}

#[test]
fn benchmark_deposit_cost_vs_prior_deposit_count() {
    for kind in [DepositKind::Reserve, DepositKind::Collateral] {
        for prior in [1usize, 100, 1000] {
            let (cpu, mem) = deposit_cost_after_prior_deposits(&kind, prior);
            std::println!(
                "DEPOSIT_BENCHMARK: kind={}, prior_deposits={}, cpu={}, mem={}",
                match kind {
                    DepositKind::Reserve => "reserve",
                    DepositKind::Collateral => "collateral",
                },
                prior,
                cpu,
                mem
            );
        }
    }
    for kind in [DepositKind::Reserve, DepositKind::Collateral] {
        for prior in [1usize, 100, 1000] {
            let (cpu, mem) = deposit_cost_isolated(&kind, prior);
            std::println!(
                "DEPOSIT_BENCHMARK_ISOLATED: kind={}, prior_deposits={}, cpu={}, mem={}",
                match kind {
                    DepositKind::Reserve => "reserve",
                    DepositKind::Collateral => "collateral",
                },
                prior,
                cpu,
                mem
            );
        }
    }
}
