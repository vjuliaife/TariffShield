import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Issue #667: DepositWizard must send exactly buildDepositRequest(xlm, bucket)
// to api.deposit, so the conversion tested in lib/deposit-request.test.ts is
// the one users actually get. (The web app has no React test runner, so this
// pins the wiring at the source level.)
describe('Issue #667 — DepositWizard sends buildDepositRequest to api.deposit', () => {
  const source = readFileSync(join(__dirname, '..', 'DepositWizard.tsx'), 'utf8');

  it('calls api.deposit with buildDepositRequest(xlm, bucket)', () => {
    assert.match(source, /api\.deposit\(importerId, buildDepositRequest\(xlm, bucket\)\)/);
  });

  it('no longer converts inline', () => {
    assert.doesNotMatch(source, /Math\.round\(Number\(xlm\)/);
  });
});
