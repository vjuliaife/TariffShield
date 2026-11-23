import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatUsd } from './api';

describe('Issue #1080 — Annual duty estimate currency formatting', () => {
  it('groups thousands and prefixes the currency symbol', () => {
    assert.equal(formatUsd('5000000'), '$5,000,000');
    assert.equal(formatUsd('250000'), '$250,000');
    assert.equal(formatUsd('100'), '$100');
  });

  it('omits cents for whole amounts but keeps them when entered', () => {
    assert.equal(formatUsd('5000000'), '$5,000,000');
    assert.equal(formatUsd('250000.5'), '$250,000.50');
    assert.equal(formatUsd('1234.567'), '$1,234.57');
  });

  it('returns null for empty or non-numeric input so callers skip the preview', () => {
    assert.equal(formatUsd(''), null);
    assert.equal(formatUsd('   '), null);
    assert.equal(formatUsd('abc'), null);
  });

  it('formats zero rather than treating it as absent', () => {
    assert.equal(formatUsd('0'), '$0');
  });

  it('accepts numbers as well as raw input strings', () => {
    assert.equal(formatUsd(5000000), '$5,000,000');
    assert.equal(formatUsd(0.5), '$0.50');
  });
});
