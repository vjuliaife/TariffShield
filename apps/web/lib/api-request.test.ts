import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api';

// request() is private; api.login exercises it directly (POST, no auth header).
const originalFetch = globalThis.fetch;
const creds = { email: 'a@b.co', password: 'pw' };

function mockFetch(body: string | null, status: number) {
  globalThis.fetch = async () =>
    new Response(body, { status, headers: body ? { 'content-type': 'application/json' } : {} });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Issue #678 — request() error handling and body parsing', () => {
  it('throws ApiError carrying status, server message and details on a non-2xx response', async () => {
    mockFetch(JSON.stringify({ error: 'validation failed', details: { field: 'amount' } }), 422);

    await assert.rejects(api.login(creds), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.ok(err instanceof Error);
      assert.equal(err.status, 422);
      assert.equal(err.message, 'validation failed');
      assert.deepEqual(err.details, { field: 'amount' });
      return true;
    });
  });

  it("falls back to 'HTTP <status>' when a non-2xx response has an empty body", async () => {
    mockFetch(null, 500);

    await assert.rejects(api.login(creds), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 500);
      assert.equal(err.message, 'HTTP 500');
      assert.equal(err.details, undefined);
      return true;
    });
  });

  it("falls back to 'HTTP <status>' when the error body has no error field", async () => {
    mockFetch(JSON.stringify({ details: { retryAfter: 30 } }), 503);

    await assert.rejects(api.login(creds), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.message, 'HTTP 503');
      assert.deepEqual(err.details, { retryAfter: 30 });
      return true;
    });
  });

  it('resolves with the parsed body on a 2xx response', async () => {
    const payload = { token: 't0k3n', user: { id: 'u1', email: 'a@b.co', role: 'importer' } };
    mockFetch(JSON.stringify(payload), 200);

    assert.deepEqual(await api.login(creds), payload);
  });

  it('resolves with null on an empty-body 2xx (204) instead of crashing JSON.parse', async () => {
    mockFetch(null, 204);

    assert.equal(await api.login(creds), null);
  });
});
