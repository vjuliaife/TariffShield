// k6 load test: concurrent deposit_collateral submissions across N distinct
// importer accounts (issue #1089).
//
// Unlike post-deposit.js (constant 50 VUs against a single KYC-gated
// importer), this script ramps concurrency in stages and registers a fresh
// importer per VU in setup(), so each iteration submits deposit_collateral
// for a *different* on-chain account. That's the scenario the investigation
// in docs/investigations/deposit-collateral-throughput.md is about: does
// ledger inclusion latency / failure rate degrade as the number of
// concurrently-submitting importer accounts grows, independent of any
// single-account nonce/sequence contention.
//
// NOTE: same KYC caveat as post-deposit.js — POST /importers/:id/deposit
// 403s until kyc_status = 'approved'. Seed approved importers before
// running this against a real environment, or read this run's error rate
// as "403 KYC gate" noise rather than a throughput signal.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, registerTestImporter } from './lib/setup.js';

export const options = {
  scenarios: {
    ramping_concurrency: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '30s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.05'],
  },
};

// Each VU gets its own importer, registered once and reused across that
// VU's iterations, so the deposits in this run land on `vus` distinct
// on-chain accounts rather than one.
export function setup() {
  return { baseUrl: BASE_URL };
}

const vuImporters = {};

function importerForThisVU(baseUrl) {
  if (!vuImporters[__VU]) {
    vuImporters[__VU] = registerTestImporter();
  }
  return vuImporters[__VU];
}

export default function (data) {
  const { token, importerId } = importerForThisVU(data.baseUrl);

  const res = http.post(
    `${data.baseUrl}/importers/${importerId}/deposit`,
    JSON.stringify({ amountStroops: '10000000', bucket: 'collateral' }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      responseCallback: http.expectedStatuses(202, 403, 429),
    }
  );
  check(res, {
    'status is 202, 403, or 429': (r) => [202, 403, 429].includes(r.status),
  });
}
