/**
 * Unit tests for the #998 white-label branding validation and defaults.
 *
 * Run with:  node --import tsx/esm --test src/lib/branding.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrandingSchema, DEFAULT_BRANDING, MAX_LOGO_DATA_URL_LENGTH } from './branding.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('BrandingSchema', () => {
  it('accepts a full branding payload', () => {
    const r = BrandingSchema.safeParse({
      slug: 'acme-surety',
      brandName: 'Acme Surety',
      logoDataUrl: PNG,
      primaryColor: '#1A2B3C',
    });
    assert.equal(r.success, true);
  });

  it('accepts nulls so each field can fall back to the default', () => {
    const r = BrandingSchema.safeParse({
      slug: 'acme',
      brandName: null,
      logoDataUrl: null,
      primaryColor: null,
    });
    assert.equal(r.success, true);
  });

  for (const slug of ['', 'Acme', '-acme', 'acme-', 'acme_surety', 'a'.repeat(41)]) {
    it(`rejects slug ${JSON.stringify(slug)}`, () => {
      assert.equal(BrandingSchema.safeParse({ slug }).success, false);
    });
  }

  for (const primaryColor of ['red', '#fff', '#12345g', '123456']) {
    it(`rejects colour ${primaryColor}`, () => {
      assert.equal(BrandingSchema.safeParse({ slug: 'acme', primaryColor }).success, false);
    });
  }

  it('rejects non-image and remote logo values', () => {
    for (const logoDataUrl of [
      'https://example.com/logo.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      'javascript:alert(1)',
    ]) {
      assert.equal(BrandingSchema.safeParse({ slug: 'acme', logoDataUrl }).success, false);
    }
  });

  it('rejects oversized logos', () => {
    const logoDataUrl = 'data:image/png;base64,' + 'A'.repeat(MAX_LOGO_DATA_URL_LENGTH);
    assert.equal(BrandingSchema.safeParse({ slug: 'acme', logoDataUrl }).success, false);
  });
});

describe('DEFAULT_BRANDING', () => {
  it('is the stock TariffShield branding', () => {
    assert.deepEqual(DEFAULT_BRANDING, {
      slug: null,
      brandName: 'TariffShield',
      logoDataUrl: null,
      primaryColor: null,
    });
  });
});
