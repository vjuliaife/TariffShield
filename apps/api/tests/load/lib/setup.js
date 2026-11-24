// Shared k6 setup helpers (issue #265).
//
// Each load-test script calls one of these from its own setup() function
// (k6 runs setup() once, before VUs start, so this network overhead —
// signup, friendbot funding, on-chain registration — is paid once per run,
// not per iteration).
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3002';

function jsonHeaders() {
  return { headers: { 'Content-Type': 'application/json' } };
}

function randomEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@k6.test`;
}

/** Sign up + log in a fresh user of the given role. Returns { token, userId }. */
export function registerUser(role) {
  const email = randomEmail(role);
  const password = 'K6LoadTest!2024';

  const signupRes = http.post(
    `${BASE_URL}/auth/signup`,
    JSON.stringify({ email, password, role, accept_tos: true }),
    jsonHeaders()
  );
  check(signupRes, { 'signup succeeded': (r) => r.status === 200 || r.status === 201 });
  if (signupRes.status >= 400) {
    fail(`signup failed: ${signupRes.status} ${signupRes.body}`);
  }
  const body = signupRes.json();
  return { token: body.token, userId: body.user && body.user.id, email };
}

/**
 * Sign up a fresh importer, register an importer entity on-chain, and wait
 * for on-chain registration to complete. Returns { token, importerId }.
 *
 * NOTE: this hits real Stellar testnet (friendbot funding + contract
 * registration inside POST /importers), so setup() can take several
 * seconds — that's expected and only paid once per k6 run.
 */
export function registerTestImporter() {
  const { token } = registerUser('importer');
  const authHeaders = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };

  const createRes = http.post(
    `${BASE_URL}/importers`,
    JSON.stringify({
      legalName: `K6 Load Test Importer ${Date.now()}`,
      bondId: Math.floor(Date.now() / 1000),
      initialRequiredCollateral: '1000000000', // 100 XLM in stroops
    }),
    authHeaders
  );
  check(createRes, { 'importer created': (r) => r.status === 200 });
  if (createRes.status >= 400) {
    fail(`importer creation failed: ${createRes.status} ${createRes.body}`);
  }

  const importerId = createRes.json('importer.id');
  return { token, importerId };
}
