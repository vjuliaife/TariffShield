/**
 * Unit tests for scripts/lib/migrate-storage-logic.ts — the v0_1_0 -> v0_2_0
 * per-account diff computation behind scripts/migrate-storage.ts --dry-run.
 *
 * No Postgres or Soroban RPC connection is used: accounts are plain objects and
 * the seed-row helper is fed canned row shapes matching pg's NUMERIC output.
 *
 * Run with:  npx tsx --test scripts/__tests__/migrate-storage.test.ts
 * (or, repo-wide: npm run test:scripts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountFromImporterRow,
  accountToMap,
  diffAccountMaps,
  planAccountMigration,
  validateAccount,
  type MigratableAccount,
} from '../lib/migrate-storage-logic.js';

const baseAccount: MigratableAccount = {
  bondId: 42n,
  collateralBalance: 500_000n,
  requiredCollateral: 400_000n,
  reserveBalance: 100_000n,
  yieldAccrued: 12_500n,
  isClawbacked: false,
  collateralLastUpdated: 1_700_000_000n,
};

describe('accountToMap', () => {
  it('maps bigint and boolean fields to strings for the migration log', () => {
    assert.deepEqual(accountToMap(baseAccount), {
      bond_id: '42',
      collateral_balance: '500000',
      required_collateral: '400000',
      reserve_balance: '100000',
      yield_accrued: '12500',
      is_clawbacked: 'false',
      collateral_last_updated: '1700000000',
    });
  });
});

describe('validateAccount', () => {
  it('accepts a well-formed account', () => {
    assert.deepEqual(validateAccount(baseAccount), { valid: true, errors: [] });
  });

  it('reports negative balances', () => {
    const { valid, errors } = validateAccount({
      ...baseAccount,
      collateralBalance: -1n,
      reserveBalance: -2n,
    });
    assert.equal(valid, false);
    assert.ok(errors.includes('collateralBalance is negative'));
    assert.ok(errors.includes('reserveBalance is negative'));
  });

  it('rejects a zero bond id', () => {
    const { valid, errors } = validateAccount({ ...baseAccount, bondId: 0n });
    assert.equal(valid, false);
    assert.ok(errors.includes('bondId is missing or zero'));
  });
});

describe('diffAccountMaps', () => {
  it('returns no changed fields for identical maps', () => {
    assert.deepEqual(diffAccountMaps(accountToMap(baseAccount), accountToMap(baseAccount)), []);
  });

  it('returns only the fields whose values differ, sorted', () => {
    const oldValues = accountToMap(baseAccount);
    const newValues = { ...oldValues, required_collateral: '450000', yield_accrued: '13000' };
    assert.deepEqual(diffAccountMaps(oldValues, newValues), [
      'required_collateral',
      'yield_accrued',
    ]);
  });

  it('treats a field missing on one side as changed', () => {
    assert.deepEqual(diffAccountMaps({ a: '1' }, { a: '1', b: '2' }), ['b']);
    assert.deepEqual(diffAccountMaps({ a: '1', b: '2' }, { a: '1' }), ['b']);
  });
});

describe('planAccountMigration', () => {
  it('produces oldValues/newValues matching the account with no changed fields (identity migration)', () => {
    const plan = planAccountMigration('GABC', baseAccount);
    assert.equal(plan.address, 'GABC');
    assert.deepEqual(plan.oldValues, accountToMap(baseAccount));
    assert.deepEqual(plan.newValues, accountToMap(baseAccount));
    assert.deepEqual(plan.changedFields, []);
  });
});

describe('accountFromImporterRow', () => {
  it('builds an offline account from pg row strings (as seeded by npm run seed)', () => {
    const account = accountFromImporterRow({
      stellar_address: 'GDEMO',
      bond_id: '5903298712098520',
      collateral_balance: '25000',
      required_collateral: '22500',
    });

    assert.deepEqual(account, {
      bondId: 5_903_298_712_098_520n,
      collateralBalance: 25_000n,
      requiredCollateral: 22_500n,
      reserveBalance: 0n,
      yieldAccrued: 0n,
      isClawbacked: false,
      collateralLastUpdated: 0n,
    });
  });

  it('defaults required collateral to zero when the importer has no tariff upload', () => {
    const account = accountFromImporterRow({
      stellar_address: 'GDEMO2',
      bond_id: 1,
      collateral_balance: 0,
      required_collateral: null,
    });
    assert.equal(account.requiredCollateral, 0n);
    assert.equal(account.bondId, 1n);
  });

  it('produces an account that passes validation and plans an empty diff', () => {
    const account = accountFromImporterRow({
      stellar_address: 'GDEMO3',
      bond_id: '12',
      collateral_balance: '0',
      required_collateral: '4500',
    });
    assert.equal(validateAccount(account).valid, true);
    assert.deepEqual(planAccountMigration('GDEMO3', account).changedFields, []);
  });
});
