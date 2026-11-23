import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepositRequest, STROOPS_PER_XLM } from './deposit-request';

describe('Issue #667 — DepositWizard XLM → stroops conversion', () => {
  it("'50' (the wizard's default) becomes 500000000 stroops", () => {
    assert.equal(buildDepositRequest('50', 'collateral').amountStroops, '500000000');
  });

  it("'0.1' (the minimum, step 0.1) becomes exactly 1000000 stroops", () => {
    assert.equal(buildDepositRequest('0.1', 'collateral').amountStroops, '1000000');
  });

  it("'12.3' rounds to the nearest integer stroop: 123000000", () => {
    const { amountStroops } = buildDepositRequest('12.3', 'collateral');
    assert.equal(amountStroops, '123000000');
    assert.equal(amountStroops, String(Math.round(12.3 * STROOPS_PER_XLM)));
  });

  it('absorbs float error instead of producing an off-by-one or a non-integer', () => {
    // 0.07 * 1e7 === 700000.0000000001 in IEEE-754; BigInt() on that would throw.
    assert.notEqual(0.07 * STROOPS_PER_XLM, 700000);
    assert.equal(buildDepositRequest('0.07', 'reserve').amountStroops, '700000');
    // Every one-decimal value the input's step allows converts exactly.
    for (let tenths = 1; tenths <= 1000; tenths++) {
      const xlm = (tenths / 10).toFixed(1);
      assert.equal(buildDepositRequest(xlm, 'reserve').amountStroops, String(tenths * 1_000_000), xlm);
    }
  });

  it('rounds sub-stroop input to the nearest stroop (half up)', () => {
    assert.equal(buildDepositRequest('1.23456784', 'reserve').amountStroops, '12345678');
    assert.equal(buildDepositRequest('1.23456785', 'reserve').amountStroops, '12345679');
  });

  it('passes the bucket prop through exactly', () => {
    assert.deepEqual(buildDepositRequest('50', 'collateral'), { amountStroops: '500000000', bucket: 'collateral' });
    assert.deepEqual(buildDepositRequest('50', 'reserve'), { amountStroops: '500000000', bucket: 'reserve' });
  });
});
