import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchHtsClassifications } from './hts-classification-lookup.js';

describe('searchHtsClassifications', () => {
  it('matches by partial HTS code prefix', () => {
    const results = searchHtsClassifications('6109');
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.htsCode.replace(/\D/g, '').startsWith('6109')));
  });

  it('matches by product description substring, case-insensitively', () => {
    const results = searchHtsClassifications('LAPTOPS');
    assert.ok(results.some((r) => r.htsCode === '8471.30.01'));
  });

  it('returns an empty array for an unmatched query', () => {
    const results = searchHtsClassifications('zzz-no-such-product-zzz');
    assert.deepEqual(results, []);
  });

  it('caches repeated queries (same array identity on second call)', () => {
    const first = searchHtsClassifications('sweaters');
    const second = searchHtsClassifications('SWEATERS'); // same normalized key
    assert.equal(first, second);
  });

  it('respects the limit parameter', () => {
    const results = searchHtsClassifications('a', 2); // broad match
    assert.ok(results.length <= 2);
  });
});
