import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.4/index.js';

// docker compose exposes Nginx on :80. Point BASE_URL at another team's
// deployment to run the cross-group comparison required by the report.
const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const USER_COUNT = Number(__ENV.USER_COUNT || 500);
const TARGET_PRODUCT = __ENV.TARGET_PRODUCT || 'p-1001';

// Read load is a fixed amount of work: 1,000 concurrent users each issuing
// READ_ITERATIONS requests. The run ends when that work is done, so the
// elapsed time is itself the result.
const READ_VUS = Number(__ENV.READ_VUS || 1000);
const READ_ITERATIONS = Number(__ENV.READ_ITERATIONS || 1);
const READ_LIMIT = Number(__ENV.READ_LIMIT || 10);
const READ_PAGES = Number(__ENV.READ_PAGES || 2);

const accepted = new Counter('orders_accepted');
const duplicate = new Counter('orders_duplicate');
const soldOut = new Counter('orders_sold_out');
const unexpected = new Counter('orders_unexpected');
const orderLatency = new Trend('order_latency', true);
const readLatency = new Trend('read_latency', true);

// Milliseconds since each scenario started, sampled at the end of every
// iteration. The max of this trend is the scenario's wall-clock duration.
const readElapsed = new Trend('read_elapsed_ms', true);
const writeElapsed = new Trend('write_elapsed_ms', true);
const readRequests = new Counter('read_requests');
const writeRequests = new Counter('write_requests');

export const options = {
  scenarios: {
    // Read-heavy: 1,000 concurrent users against the cached product list.
    read_load: {
      executor: 'per-vu-iterations',
      vus: READ_VUS,
      iterations: READ_ITERATIONS,
      maxDuration: '5m',
      exec: 'readProducts',
      gracefulStop: '30s',
    },
    // Write-heavy: 500 distinct users racing for 50 units. Starts one second
    // in so the read load is already saturating the system.
    write_load: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      startTime: '1s',
      maxDuration: '2m',
      exec: 'placeOrder',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    // Every request must be answered with a valid business outcome.
    checks: ['rate>0.99'],
    read_latency: ['p(95)<500'],
    // The write burst is measured while 1,000 readers already saturate the
    // CPU, so this budget covers queueing at the edge, not the handler.
    order_latency: ['p(95)<3000'],
  },
};

/**
 * Preparation phase: mint one JWT per simulated user before the measured
 * traffic starts, so authentication never shows up in the results.
 */
export function setup() {
  const tokens = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: `user-${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status !== 200) {
      throw new Error(`auth failed for user-${i}: ${res.status} ${res.body}`);
    }
    tokens.push(res.json('accessToken'));
  }
  return { tokens };
}

export function readProducts() {
  // Spread readers across pages so the test is not a single hot key.
  const page = ((__VU + __ITER) % READ_PAGES) + 1;
  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${READ_LIMIT}`,
    { tags: { name: 'GET /products' } },
  );
  readLatency.add(res.timings.duration);
  readRequests.add(1);
  check(res, {
    'read 200': (r) => r.status === 200,
    'read has data': (r) => {
      try {
        return Array.isArray(r.json('data'));
      } catch (_) {
        return false;
      }
    },
  });
  readElapsed.add(Date.now() - exec.scenario.startTime);
}

export function placeOrder(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    tags: { name: 'POST /orders' },
  };
  const payload = JSON.stringify({ productId: TARGET_PRODUCT });

  // Every fifth user double-taps: three simultaneous requests from the same
  // JWT, which must still yield at most one reservation.
  const burst = __VU % 5 === 0 ? 3 : 1;
  const requests = [];
  for (let i = 0; i < burst; i++) {
    requests.push(['POST', `${BASE_URL}/api/v1/orders`, payload, params]);
  }

  const responses = http.batch(requests);
  for (const res of responses) {
    orderLatency.add(res.timings.duration);
    writeRequests.add(1);
    if (res.status === 202) accepted.add(1);
    else if (res.status === 409) duplicate.add(1);
    else if (res.status === 410) soldOut.add(1);
    else unexpected.add(1);

    check(res, {
      'order handled': (r) =>
        r.status === 202 || r.status === 409 || r.status === 410,
    });
  }
  writeElapsed.add(Date.now() - exec.scenario.startTime);
}

export function teardown() {
  const res = http.get(`${BASE_URL}/api/v1/metrics/cache`);
  if (res.status === 200) {
    console.log(`cache stats: ${res.body}`);
  }
}

function fmt(ms) {
  return `${(ms / 1000).toFixed(2)}s (${Math.round(ms)} ms)`;
}

/**
 * k6's default summary reports latency per request; this adds the number the
 * assignment actually asks for - how long the whole fixed workload took.
 */
export function handleSummary(data) {
  const m = data.metrics;
  const readMs = m.read_elapsed_ms ? m.read_elapsed_ms.values.max : 0;
  const writeMs = m.write_elapsed_ms ? m.write_elapsed_ms.values.max : 0;
  const readReqs = m.read_requests ? m.read_requests.values.count : 0;
  const writeReqs = m.write_requests ? m.write_requests.values.count : 0;

  const lines = [
    '',
    '  █ WORKLOAD COMPLETION TIME',
    '',
    `    read  : ${READ_VUS} concurrent users x ${READ_ITERATIONS} requests`,
    `            ${readReqs} requests in ${fmt(readMs)}`,
    `            ${(readReqs / (readMs / 1000)).toFixed(0)} req/s`,
    '',
    `    write : ${USER_COUNT} concurrent users (every 5th fires 3x)`,
    `            ${writeReqs} requests in ${fmt(writeMs)}`,
    `            ${(writeReqs / (writeMs / 1000)).toFixed(0)} req/s`,
    '',
    `    total run: ${fmt(data.state.testRunDurationMs)}`,
    '',
  ];

  return {
    stdout:
      lines.join('\n') + '\n' +
      textSummary(data, { indent: '  ', enableColors: true }),
  };
}
