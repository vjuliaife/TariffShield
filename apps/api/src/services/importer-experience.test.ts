import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboardingSteps, hasValidParticipationTotal } from './importer-experience.js';

describe('co-surety participation validation', () => {
  it('accepts exact percentage splits represented in basis points', () => {
    assert.equal(
      hasValidParticipationTotal([
        { reference: 'A', percentage: 50 },
        { reference: 'B', percentage: 30 },
        { reference: 'C', percentage: 20 },
      ]),
      true
    );
  });

  it('rejects totals other than 100% and precision smaller than a basis point', () => {
    assert.equal(
      hasValidParticipationTotal([
        { reference: 'A', percentage: 50 },
        { reference: 'B', percentage: 49.99 },
      ]),
      false
    );
    assert.equal(hasValidParticipationTotal([{ reference: 'A', percentage: 99.999 }]), false);
  });
});

describe('importer onboarding checklist', () => {
  it('derives step status from KYC, deposit, and tariff upload state', () => {
    const steps = buildOnboardingSteps(true, false, true);
    assert.deepEqual(
      steps.map((step) => step.complete),
      [true, false, true]
    );
    assert.equal(steps[1]?.href, '/app#deposit');
  });
});
