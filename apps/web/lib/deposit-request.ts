/** 1 XLM = 10,000,000 stroops. */
export const STROOPS_PER_XLM = 1e7;

export type DepositBucket = 'collateral' | 'reserve';

/**
 * Request body DepositWizard sends to `api.deposit` (#667).
 *
 * Converts the XLM amount typed into the wizard (a decimal string, step 0.1)
 * to integer stroops, rounding to the nearest stroop so float error in
 * `Number(xlm) * 1e7` (e.g. 0.07 * 1e7 = 700000.0000000001) can't leak into
 * the amount or make BigInt() throw on a non-integer. `bucket` is passed through unchanged.
 */
export function buildDepositRequest(
  xlm: string,
  bucket: DepositBucket,
): { amountStroops: string; bucket: DepositBucket } {
  const amountStroops = BigInt(Math.round(Number(xlm) * STROOPS_PER_XLM)).toString();
  return { amountStroops, bucket };
}
