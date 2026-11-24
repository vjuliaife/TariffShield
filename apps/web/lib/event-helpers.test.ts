import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getEventAmountLabel, isNonMonetaryEventKind } from './event-helpers';

describe('Issue #1066 — Event log row amount labeling', () => {
  it('correctly identifies non-monetary event kinds', () => {
    assert.equal(isNonMonetaryEventKind('tariff_exposure_updated'), true);
    assert.equal(isNonMonetaryEventKind('importer_registered'), true);
    assert.equal(isNonMonetaryEventKind('required_changed'), true);
    assert.equal(isNonMonetaryEventKind('bond_updated'), true);
    assert.equal(isNonMonetaryEventKind('deposit'), false);
    assert.equal(isNonMonetaryEventKind('withdrawal'), false);
  });

  it('renders "no amount" for non-monetary event kinds with falsy amount', () => {
    const label1 = getEventAmountLabel({ kind: 'tariff_exposure_updated', amount: null });
    assert.equal(label1, 'no amount');

    const label2 = getEventAmountLabel({ kind: 'importer_registered', amount: null });
    assert.equal(label2, 'no amount');

    const label3 = getEventAmountLabel({ kind: 'required_changed', amount: '0' });
    assert.equal(label3, 'no amount');
  });

  it('renders XLM amount when positive amount exists even for non-monetary kinds', () => {
    const label = getEventAmountLabel({ kind: 'required_changed', amount: '50000000' });
    assert.equal(label, '5.0000 XLM');
  });

  it('renders bare dash "—" only for monetary event kinds with missing/falsy amount', () => {
    const label1 = getEventAmountLabel({ kind: 'deposit', amount: null });
    assert.equal(label1, '—');

    const label2 = getEventAmountLabel({ kind: 'withdrawal', amount: null });
    assert.equal(label2, '—');

    const label3 = getEventAmountLabel({ kind: 'unknown_event_type', amount: null });
    assert.equal(label3, '—');
  });
});
