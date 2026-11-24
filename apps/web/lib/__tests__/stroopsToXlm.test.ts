/**
 * Issue #676: Unit test stroopsToXlm formats fractional stroops with zero-padding to four decimals
 * 
 * Tests the stroopsToXlm function from lib/api.ts (lines 138-143)
 * Verifies padding/truncation behavior across whole, small-fraction, and string/bigint/number input types
 */

import { describe, expect, it } from 'vitest';
import { stroopsToXlm } from '../api';

describe('stroopsToXlm', () => {
  it('formats 500000000 stroops as 50.0000 XLM', () => {
    expect(stroopsToXlm('500000000')).toBe('50.0000');
  });

  it('formats tiny fractional remainder (10000 stroops) with correct zero-padding', () => {
    // 10000 stroops = 0.0010000 XLM, should show as '0.0010'
    expect(stroopsToXlm('10000')).toBe('0.0010');
    // Should NOT return '0.1' or unpadded digits
    expect(stroopsToXlm('10000')).not.toBe('0.1');
  });

  it('accepts bigint input and returns same result as equivalent string', () => {
    const stroops = '500000000';
    const resultString = stroopsToXlm(stroops);
    const resultBigInt = stroopsToXlm(BigInt(stroops));
    expect(resultBigInt).toBe(resultString);
    expect(resultBigInt).toBe('50.0000');
  });

  it('accepts number input and returns same result as equivalent string', () => {
    const stroops = 500000000;
    const resultNumber = stroopsToXlm(stroops);
    const resultString = stroopsToXlm(stroops.toString());
    expect(resultNumber).toBe(resultString);
    expect(resultNumber).toBe('50.0000');
  });

  it('formats 0 stroops as 0.0000 XLM', () => {
    expect(stroopsToXlm('0')).toBe('0.0000');
    expect(stroopsToXlm(0)).toBe('0.0000');
    expect(stroopsToXlm(0n)).toBe('0.0000');
  });

  it('formats 1 stroop (smallest unit) with correct zero-padding', () => {
    // 1 stroop = 0.0000001 XLM, truncated to 4 decimals = '0.0000'
    expect(stroopsToXlm('1')).toBe('0.0000');
  });

  it('formats 10000000 stroops (exactly 1 XLM) as 1.0000', () => {
    expect(stroopsToXlm('10000000')).toBe('1.0000');
  });

  it('formats large amounts correctly', () => {
    // 123456789012345 stroops = 12345678.9012345 XLM, truncated to 4 decimals
    expect(stroopsToXlm('123456789012345')).toBe('12345678.9012');
  });

  it('pads fractional part to exactly 4 digits', () => {
    // 100000 stroops = 0.0100000 XLM → should show '0.0100'
    expect(stroopsToXlm('100000')).toBe('0.0100');
    
    // 1000 stroops = 0.0001000 XLM → should show '0.0001'
    expect(stroopsToXlm('1000')).toBe('0.0001');
    
    // 100 stroops = 0.0000100 XLM → should show '0.0000' (truncated)
    expect(stroopsToXlm('100')).toBe('0.0000');
  });

  it('truncates beyond 4 decimal places', () => {
    // 12345678 stroops = 1.2345678 XLM → should truncate to '1.2345'
    expect(stroopsToXlm('12345678')).toBe('1.2345');
  });

  it('handles negative values (if applicable)', () => {
    // Note: The current implementation uses BigInt modulo which works with negatives
    // -500000000 stroops = -50.0000000 XLM
    expect(stroopsToXlm('-500000000')).toBe('-50.0000');
  });
});
