import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearSession, getUser, isAuthenticated, setSession, type AuthUser } from './auth';

type Storage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const originalWindow = (globalThis as { window?: unknown }).window;

function installStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe('authentication session state', () => {
  it('tracks a session through setSession and clearSession', () => {
    installStorage();
    const user: AuthUser = { id: 'user-1', email: 'user@example.com', role: 'importer' };

    assert.equal(isAuthenticated(), false);
    setSession('token-1', user);
    assert.equal(isAuthenticated(), true);
    assert.deepEqual(getUser(), user);

    clearSession();
    assert.equal(isAuthenticated(), false);
    assert.equal(getUser(), null);
  });
});