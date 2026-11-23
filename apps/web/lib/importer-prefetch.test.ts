import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('importer prefetch cache', () => {
  it('consumes a prefetched importer on the first read and fetches again later', async () => {
    let calls = 0;
    const payload = { id: 'importer-1' };
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    api.prefetchImporter('importer-1');
    assert.deepEqual(await api.getImporter('importer-1'), payload);
    assert.equal(calls, 1);

    assert.deepEqual(await api.getImporter('importer-1'), payload);
    assert.equal(calls, 2);
  });
});