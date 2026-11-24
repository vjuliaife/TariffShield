// k6 load test: Terms of Service Acceptance Endpoints (issue #569)
//
// Endpoints covered:
// - GET  /account/tos-history (read acceptance history)
// - POST /account/accept-tos (accept current or updated ToS version)
//
// Target:
// - p95 latency: < 200ms for read (GET), < 500ms for write (POST)
// - error rate: < 0.1% at 50 VUs (duration 1m)
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL, registerUser } from './lib/setup.js';

const getTosHistoryDuration = new Trend('get_tos_history_duration');
const postAcceptTosDuration = new Trend('post_accept_tos_duration');

export const options = {
  vus: 50,
  duration: '1m',
  thresholds: {
    get_tos_history_duration: ['p(95)<200'],
    post_accept_tos_duration: ['p(95)<500'],
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const user = registerUser('importer');
  return {
    token: user.token,
    versionId: 'v1.0.0',
  };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };

  // 1. GET /account/tos-history (read path, target: p95 < 200ms)
  const getRes = http.get(`${BASE_URL}/account/tos-history`, {
    headers,
    tags: { name: 'GET /account/tos-history' },
  });
  getTosHistoryDuration.add(getRes.timings.duration);

  check(getRes, {
    'get tos history status is 200': (r) => r.status === 200,
    'has acceptances array': (r) => Array.isArray(r.json('acceptances')),
  });

  // 2. POST /account/accept-tos (write path, target: p95 < 500ms)
  const postRes = http.post(
    `${BASE_URL}/account/accept-tos`,
    JSON.stringify({ versionId: data.versionId }),
    { headers, tags: { name: 'POST /account/accept-tos' } }
  );
  postAcceptTosDuration.add(postRes.timings.duration);

  check(postRes, {
    'post accept tos status is 200': (r) => r.status === 200,
    'accepted is true': (r) => r.json('accepted') === true,
  });
}
