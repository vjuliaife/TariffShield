import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectYield } from './yieldWorker';
import type { YieldProjectionRequest } from './yieldWorker.types';

const input = (overrides: Partial<YieldProjectionRequest> = {}): YieldProjectionRequest => ({
  currentBalanceStroops: '1000000000',
  monthlyTopUpStroops: '100000000',
  months: 2,
  annualYieldBps: 1200,
  ...overrides,
});

describe('projectYield', () => {
  it('applies monthly interest before adding the recurring top-up', () => {
    const result = projectYield(input());

    assert.deepEqual(result.monthly.map((entry) => entry.balanceStroops), [
      '1110000000',
      '1121100000',
    ]);
    assert.equal(result.totalYieldStroops, '21100000');
  });

  it('keeps total yield free of top-up principal when no top-up is used', () => {
    const result = projectYield(input({ monthlyTopUpStroops: '0' }));

    assert.equal(result.monthly[0].balanceStroops, '1010000000');
    assert.equal(result.monthly[1].balanceStroops, '1020100000');
    assert.equal(result.totalYieldStroops, '20100000');
  });

  it('returns one numeric monthly balance per requested month with sequential numbering', () => {
    const result = projectYield(input({ months: 12 }));

    assert.equal(result.monthly.length, 12);
    assert.equal(result.monthly[0].month, 1);
    assert.equal(result.monthly[11].month, 12);
    for (const entry of result.monthly) {
      assert.doesNotThrow(() => BigInt(entry.balanceStroops));
    }
    assert.equal(result.monthly.at(-1)?.balanceStroops, result.projectedBalanceStroops);
  });
});