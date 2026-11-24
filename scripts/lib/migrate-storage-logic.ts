/**
 * Pure migration-planning logic for scripts/migrate-storage.ts.
 *
 * Kept in its own module so the v0_1_0 -> v0_2_0 per-account diff computation
 * can be unit-tested without a Soroban RPC or Postgres connection — see
 * scripts/__tests__/migrate-storage.test.ts.
 */

/** The subset of the on-chain `Account` struct the migration script re-persists. */
export interface MigratableAccount {
  bondId: bigint;
  collateralBalance: bigint;
  requiredCollateral: bigint;
  reserveBalance: bigint;
  yieldAccrued: bigint;
  isClawbacked: boolean;
  collateralLastUpdated: bigint;
}

/** One account's planned migration, shaped for the MigrationLog entries. */
export interface AccountMigrationPlan {
  address: string;
  oldValues: Record<string, string>;
  newValues: Record<string, string>;
  /** Field names whose values differ between oldValues and newValues. */
  changedFields: string[];
}

/** Row shape produced by the `importers` + latest `tariff_uploads` query used by
 * `--dry-run --offline`. pg returns NUMERIC/BIGINT columns as strings. */
export interface ImporterSeedRow {
  stellar_address: string;
  bond_id: string | number;
  collateral_balance: string | number;
  required_collateral: string | number | null;
}

/** Converts an on-chain account into the string map recorded in MigrationLog. */
export function accountToMap(account: MigratableAccount): Record<string, string> {
  return {
    bond_id: account.bondId.toString(),
    collateral_balance: account.collateralBalance.toString(),
    required_collateral: account.requiredCollateral.toString(),
    reserve_balance: account.reserveBalance.toString(),
    yield_accrued: account.yieldAccrued.toString(),
    is_clawbacked: account.isClawbacked.toString(),
    collateral_last_updated: account.collateralLastUpdated.toString(),
  };
}

/** Sanity-checks an account before it is planned or submitted for migration. */
export function validateAccount(account: MigratableAccount): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (account.collateralBalance < 0n) {
    errors.push('collateralBalance is negative');
  }
  if (account.requiredCollateral < 0n) {
    errors.push('requiredCollateral is negative');
  }
  if (account.reserveBalance < 0n) {
    errors.push('reserveBalance is negative');
  }
  if (account.yieldAccrued < 0n) {
    errors.push('yieldAccrued is negative');
  }
  if (!account.bondId || account.bondId === 0n) {
    errors.push('bondId is missing or zero');
  }
  if (typeof account.isClawbacked !== 'boolean') {
    errors.push('isClawbacked is not a boolean');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Returns the field names whose values differ between two account maps, sorted. */
export function diffAccountMaps(
  oldValues: Record<string, string>,
  newValues: Record<string, string>
): string[] {
  const fields = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  return [...fields].filter((field) => oldValues[field] !== newValues[field]).sort();
}

/**
 * Computes the planned v0_1_0 -> v0_2_0 migration for one account.
 *
 * The `Account` struct itself is unchanged by this migration — the contract
 * re-persists it under the new WASM via `migrate_account` — so oldValues and
 * newValues currently match and changedFields is empty. The diff machinery
 * exists so a future storage-layout change surfaces in the dry-run output and
 * MigrationLog without touching the CLI.
 */
export function planAccountMigration(
  address: string,
  account: MigratableAccount
): AccountMigrationPlan {
  const oldValues = accountToMap(account);
  const newValues = accountToMap(account);
  return { address, oldValues, newValues, changedFields: diffAccountMaps(oldValues, newValues) };
}

/**
 * Builds a MigratableAccount from a local Postgres row (`importers` joined with
 * the seed's latest `tariff_uploads` entry). Used by `--dry-run --offline` so
 * contributors can exercise the migration plan against the demo importers from
 * `npm run seed` without a deployed contract. Fields that only exist on-chain
 * (reserve, yield, timestamps) default to zero/false.
 */
export function accountFromImporterRow(row: ImporterSeedRow): MigratableAccount {
  return {
    bondId: BigInt(row.bond_id),
    collateralBalance: BigInt(row.collateral_balance ?? 0),
    requiredCollateral: BigInt(row.required_collateral ?? 0),
    reserveBalance: 0n,
    yieldAccrued: 0n,
    isClawbacked: false,
    collateralLastUpdated: 0n,
  };
}
