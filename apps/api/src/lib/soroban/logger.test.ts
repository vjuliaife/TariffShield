/**
 * Tests for the Soroban RPC trace logger after routing it through pino (#972).
 *
 * Run via: node --import tsx/esm --test src/lib/soroban/logger.test.ts
 *
 * The env stubs mirror src/__tests__/integration/health-db.test.ts: the
 * module imports the app logger, which reads the validated env config.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub('DATABASE_URL', 'postgres://fake:fake@localhost:1/fake');
stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { isSorobanRpcLoggingEnabled, redact } = await import('./logger.js');

describe('isSorobanRpcLoggingEnabled (#972)', () => {
  it('is off by default', () => {
    assert.equal(isSorobanRpcLoggingEnabled({}), false);
  });

  it('turns on with SOROBAN_DEBUG=true', () => {
    assert.equal(isSorobanRpcLoggingEnabled({ SOROBAN_DEBUG: 'true' }), true);
  });

  for (const ns of ['soroban:*', 'tariffshield:soroban', '*']) {
    it(`turns on with DEBUG=${ns}`, () => {
      assert.equal(isSorobanRpcLoggingEnabled({ DEBUG: `express:*, ${ns}` }), true);
    });
  }

  it('ignores unrelated DEBUG namespaces', () => {
    assert.equal(isSorobanRpcLoggingEnabled({ DEBUG: 'express:*' }), false);
  });

  it('stays off under NODE_ENV=test unless FORCE_SOROBAN_DEBUG=true', () => {
    assert.equal(isSorobanRpcLoggingEnabled({ NODE_ENV: 'test', SOROBAN_DEBUG: 'true' }), false);
    assert.equal(
      isSorobanRpcLoggingEnabled({
        NODE_ENV: 'test',
        SOROBAN_DEBUG: 'true',
        FORCE_SOROBAN_DEBUG: 'true',
      }),
      true
    );
  });
});

describe('redact (#972)', () => {
  it('redacts Stellar secret keys, long base64 blobs and secret/source fields', () => {
    const secret = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
    const xdr = 'A'.repeat(120);
    assert.deepEqual(
      redact({
        method: 'sendTransaction',
        params: { transaction: xdr, signers: [secret, 'GABC'] },
        secretKey: 'anything',
        Source: 'GSOURCE',
      }),
      {
        method: 'sendTransaction',
        params: { transaction: '[REDACTED]', signers: ['[REDACTED]', 'GABC'] },
        secretKey: '[REDACTED]',
        Source: '[REDACTED]',
      }
    );
  });

  it('passes through primitives, null and short strings unchanged', () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(42), 42);
    assert.equal(redact('getLatestLedger'), 'getLatestLedger');
  });
});
