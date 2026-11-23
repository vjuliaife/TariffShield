/**
 * yieldWorker — offloads bond-collateral yield projection to a WebWorker
 * (issue #260), so compound-interest / scenario-modeling math never blocks
 * the main thread.
 *
 * This is a module worker: Next.js/webpack bundles it as its own chunk when
 * instantiated via `new Worker(new URL("./yieldWorker.ts", import.meta.url))`
 * (see useYieldProjection.ts). Do not import this file directly from
 * component code — always go through the worker boundary.
 */
import type { YieldProjectionRequest, YieldProjectionResponse } from './yieldWorker.types';

/**
 * Projects collateral balance growth month-by-month under simulated BENJI
 * yield accrual (matching the "Yield accrued (sim BENJI)" figure shown
 * elsewhere in the dashboard) plus a recurring top-up schedule.
 *
 * Deliberately uses floating-point XLM (not on-chain fixed-point stroops)
 * math — this is a client-side estimate/scenario tool, not a source of
 * truth for actual settlement, consistent with the rest of the dashboard's
 * "sim BENJI" framing.
 */
export function projectYield(input: YieldProjectionRequest): YieldProjectionResponse {
  const { currentBalanceStroops, monthlyTopUpStroops, months, annualYieldBps } = input;

  if (months <= 0 || months > 600) {
    throw new Error('months must be between 1 and 600');
  }
  if (annualYieldBps < 0 || annualYieldBps > 10_000) {
    throw new Error('annualYieldBps must be between 0 and 10000');
  }

  const STROOPS_PER_XLM = 1e7;
  let balanceXlm = Number(BigInt(currentBalanceStroops)) / STROOPS_PER_XLM;
  const monthlyTopUpXlm = Number(BigInt(monthlyTopUpStroops)) / STROOPS_PER_XLM;
  const monthlyRate = annualYieldBps / 10_000 / 12;

  const startBalanceXlm = balanceXlm;
  const monthly: YieldProjectionResponse['monthly'] = [];

  for (let month = 1; month <= months; month++) {
    balanceXlm = balanceXlm * (1 + monthlyRate) + monthlyTopUpXlm;
    monthly.push({
      month,
      balanceStroops: String(Math.round(balanceXlm * STROOPS_PER_XLM)),
    });
  }

  const totalYieldXlm = balanceXlm - startBalanceXlm - monthlyTopUpXlm * months;

  return {
    months,
    projectedBalanceStroops: String(Math.round(balanceXlm * STROOPS_PER_XLM)),
    totalYieldStroops: String(Math.round(totalYieldXlm * STROOPS_PER_XLM)),
    monthly,
  };
}

if (typeof self !== 'undefined') {
self.onmessage = (event: MessageEvent<YieldProjectionRequest>) => {
  try {
    const result = projectYield(event.data);
    self.postMessage({ ok: true, result } satisfies { ok: true; result: YieldProjectionResponse });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies { ok: false; error: string });
  }
};

}