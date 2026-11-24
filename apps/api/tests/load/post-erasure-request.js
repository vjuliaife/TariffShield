// k6 load test: GDPR/CCPA Erasure Request Endpoints (issue #568)
//
// Endpoints covered:
// - POST /account/erasure-request (create erasure request)
// - GET  /account/erasure-request/:requestId (poll erasure request status)
//
// Target:
// - p95 latency: < 500ms for write (POST), < 200ms for read (GET)
// - error rate: < 0.1% at 50 VUs (duration 1m)
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL, registerUser } from './lib/setup.js';

const postErasureDuration = new Trend('post_erasure_req_duration');
const getErasureDuration = new Trend('get_erasure_req_duration');

export const options = {
  vus: 50,
  duration: '1m',
  thresholds: {
    post_erasure_req_duration: ['p(95)<500'],
    get_erasure_req_duration: ['p(95)<200'],
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  return registerUser('importer');
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };

  // 1. POST /account/erasure-request (write path, target: p95 < 500ms)
  const postRes = http.post(
    `${BASE_URL}/account/erasure-request`,
    JSON.stringify({ reason: 'k6 load test erasure request' }),
    { headers, tags: { name: 'POST /account/erasure-request' } }
  );
  postErasureDuration.add(postRes.timings.duration);

  check(postRes, {
    'post erasure status is 202': (r) => r.status === 202,
    'returns requestId': (r) => !!r.json('requestId'),
  });

  const requestId = postRes.json('requestId');
  if (requestId) {
    // 2. GET /account/erasure-request/:requestId (read path, target: p95 < 200ms)
    const getRes = http.get(`${BASE_URL}/account/erasure-request/${requestId}`, {
      headers,
      tags: { name: 'GET /account/erasure-request/:requestId' },
    });
    getErasureDuration.add(getRes.timings.duration);

    check(getRes, {
      'get erasure status is 200': (r) => r.status === 200,
      'has status': (r) => !!r.json('status'),
    });
  }
}
