/**
 * Unit tests for scripts/rotate-admin.ts.
 *
 * Covers getNativeBalance's balance-parsing (including the catch-and-fall-back-to-0n
 * path), rotateAdmin's --dry-run short-circuit, and the Render/Vercel provider secret
 * update helpers (200 and 409-already-exists branches). No live network or Soroban RPC
 * connection is used — the Soroban RPC server and global fetch are both mocked.
 *
 * Run via:  npm run test:scripts
 */

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  getNativeBalance,
  rotateAdmin,
  parseArgs,
  resolveShowSecret,
  updateRenderSecret,
  updateVercelSecret,
} from '../rotate-admin.js';

describe('getNativeBalance', () => {
  it("parses the native balance from the account's balances array", async () => {
    const fakeServer = {
      getAccount: async () => ({
        balances: [
          { asset_type: 'credit_alphanum4', balance: '999.0000000' },
          { asset_type: 'native', balance: '42.5000000' },
        ],
      }),
    };

    const balance = await getNativeBalance(fakeServer as any, 'GFAKE');
    assert.equal(balance, 425_000_000n);
  });

  it('returns 0n when no native balance entry exists', async () => {
    const fakeServer = {
      getAccount: async () => ({
        balances: [{ asset_type: 'credit_alphanum4', balance: '10.0000000' }],
      }),
    };

    const balance = await getNativeBalance(fakeServer as any, 'GFAKE');
    assert.equal(balance, 0n);
  });

  it('falls back to 0n when getAccount throws', async () => {
    const fakeServer = {
      getAccount: async () => {
        throw new Error('account not found');
      },
    };

    const balance = await getNativeBalance(fakeServer as any, 'GFAKE');
    assert.equal(balance, 0n);
  });

  it('falls back to 0n when the account response has no balances field at all', async () => {
    const fakeServer = {
      getAccount: async () => ({}),
    };

    const balance = await getNativeBalance(fakeServer as any, 'GFAKE');
    assert.equal(balance, 0n);
  });
});

describe('rotateAdmin --dry-run', () => {
  it('returns the prepared transaction XDR without calling sendTransaction', async () => {
    const currentAdmin = Keypair.random();
    const newAdmin = Keypair.random();

    const sendTransaction = mock.fn(async () => {
      throw new Error('sendTransaction must not be called in --dry-run mode');
    });

    const fakeAccount = { accountId: () => currentAdmin.publicKey(), sequenceNumber: () => '1' };
    const fakePreparedTx = { toXDR: () => 'FAKE_XDR_STRING', sign: mock.fn() };

    const fakeServer = {
      getAccount: async () => fakeAccount,
      prepareTransaction: async () => fakePreparedTx,
      sendTransaction,
    };

    const originalBuilder = await import('@stellar/stellar-sdk');
    const buildStub = mock.method(
      originalBuilder.TransactionBuilder.prototype,
      'build',
      function (this: any) {
        return fakePreparedTx;
      }
    );
    const addOpStub = mock.method(
      originalBuilder.TransactionBuilder.prototype,
      'addOperation',
      function (this: any) {
        return this;
      }
    );
    const setTimeoutStub = mock.method(
      originalBuilder.TransactionBuilder.prototype,
      'setTimeout',
      function (this: any) {
        return this;
      }
    );

    try {
      const result = await rotateAdmin({
        server: fakeServer as any,
        contractId: 'CA4XHIJVTYFEATMWUUUDKCEIRXXOSMIYKNLFLHYM4UBCLYD4FPIXNJIU',
        networkPassphrase: 'Test SDF Network ; September 2015',
        currentAdmin,
        newAdmin,
        dryRun: true,
      });

      assert.equal(result, 'FAKE_XDR_STRING');
      assert.equal(sendTransaction.mock.callCount(), 0);
    } finally {
      buildStub.mock.restore();
      addOpStub.mock.restore();
      setTimeoutStub.mock.restore();
    }
  });
});

describe('updateRenderSecret', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('is a no-op when RENDER_API_KEY is not set', async () => {
    delete process.env.RENDER_API_KEY;
    const fetchMock = mock.fn();
    globalThis.fetch = fetchMock as any;

    await updateRenderSecret('SNEWSECRET', 'tariffshield-api');

    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('updates the secret on a 200 response from the env-vars PUT', async () => {
    process.env.RENDER_API_KEY = 'fake-render-key';
    const fetchMock = mock.fn(async (url: string, opts: any) => {
      if (opts?.method === undefined) {
        // the list-services GET call
        return {
          ok: true,
          status: 200,
          json: async () => [{ service: { id: 'srv-123', name: 'tariffshield-api' } }],
        };
      }
      // the PUT env-vars call
      return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock as any;

    await updateRenderSecret('SNEWSECRET', 'tariffshield-api');

    assert.equal(fetchMock.mock.callCount(), 2);
  });

  it('warns and returns without throwing when the service is not found', async () => {
    process.env.RENDER_API_KEY = 'fake-render-key';
    const fetchMock = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    globalThis.fetch = fetchMock as any;

    await assert.doesNotReject(() => updateRenderSecret('SNEWSECRET', 'unknown-service'));
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});

describe('updateVercelSecret', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('is a no-op when VERCEL_TOKEN is not set', async () => {
    delete process.env.VERCEL_TOKEN;
    const fetchMock = mock.fn();
    globalThis.fetch = fetchMock as any;

    await updateVercelSecret('SNEWSECRET', 'tariffshield-web');

    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('creates the variable on a clean 200/201 upsert response', async () => {
    process.env.VERCEL_TOKEN = 'fake-vercel-token';
    const fetchMock = mock.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
    globalThis.fetch = fetchMock as any;

    await updateVercelSecret('SNEWSECRET', 'tariffshield-web');

    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it('patches the existing variable on a 409 already-exists response', async () => {
    process.env.VERCEL_TOKEN = 'fake-vercel-token';
    let call = 0;
    const fetchMock = mock.fn(async (url: string, opts: any) => {
      call += 1;
      if (call === 1) {
        // initial upsert POST -> conflict
        return { ok: false, status: 409, json: async () => ({}) };
      }
      if (call === 2) {
        // list existing env vars
        return {
          ok: true,
          status: 200,
          json: async () => ({ envs: [{ id: 'env-1', key: 'PLATFORM_STELLAR_SECRET' }] }),
        };
      }
      // patch existing
      return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock as any;

    await updateVercelSecret('SNEWSECRET', 'tariffshield-web');

    assert.equal(fetchMock.mock.callCount(), 3);
  });
});

describe('--show-secret confirmation gate', () => {
  const never = async () => {
    throw new Error('prompt should not be called');
  };

  it('parseArgs recognises --yes and -y, defaulting to false', () => {
    assert.equal(parseArgs(['--show-secret']).yes, false);
    assert.equal(parseArgs(['--show-secret', '--yes']).yes, true);
    assert.equal(parseArgs(['--show-secret', '-y']).yes, true);
  });

  it('skips the prompt and allows printing when --yes is given', async () => {
    assert.equal(await resolveShowSecret({ yes: true, isTTY: false, prompt: never }), true);
  });

  it('refuses without prompting when there is no TTY and no --yes', async () => {
    assert.equal(await resolveShowSecret({ yes: false, isTTY: false, prompt: never }), false);
  });

  it('allows printing on an affirmative answer in a TTY', async () => {
    for (const answer of ['yes', ' YES ', 'y']) {
      assert.equal(await resolveShowSecret({ yes: false, isTTY: true, prompt: async () => answer }), true);
    }
  });

  it('aborts on any other answer in a TTY', async () => {
    for (const answer of ['', 'no', 'maybe']) {
      assert.equal(await resolveShowSecret({ yes: false, isTTY: true, prompt: async () => answer }), false);
    }
  });
});
