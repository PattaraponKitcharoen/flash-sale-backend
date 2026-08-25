import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// docker compose exposes Nginx on :80. Point BASE_URL at another team's
// deployment to run the cross-group comparison required by the report.
const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const USER_COUNT = Number(__ENV.USER_COUNT || 500);
const TARGET_PRODUCT = __ENV.TARGET_PRODUCT || 'p-1001';
const READ_VUS = Number(__ENV.READ_VUS || 1000);
const READ_DURATION = __ENV.READ_DURATION || '30s';

const accepted = new Counter('orders_accepted');
const duplicate = new Counter('orders_duplicate');
const soldOut = new Counter('orders_sold_out');
const unexpected = new Counter('orders_unexpected');
const orderLatency = new Trend('order_latency', true);
const readLatency = new Trend('read_latency', true);

export const options = {
  scenarios: {
    // Read-heavy: 1,000 concurrent users hammering the cached product list.
    read_load: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: READ_DURATION,
      exec: 'readProducts',
      gracefulStop: '10s',
    },
    // Write-heavy: 500 distinct users racing for 50 units, starting once the
    // read load is already saturating the system.
    write_load: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      startTime: '5s',
      maxDuration: '60s',
      exec: 'placeOrder',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    // Every request must be answered with a valid business outcome.
    checks: ['rate>0.99'],
    read_latency: ['p(95)<200'],
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
  const page = ((__ITER % 2) + 1);
  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=10`,
    { tags: { name: 'GET /products' } },
  );
  readLatency.add(res.timings.duration);
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
    if (res.status === 202) accepted.add(1);
    else if (res.status === 409) duplicate.add(1);
    else if (res.status === 410) soldOut.add(1);
    else unexpected.add(1);

    check(res, {
      'order handled': (r) =>
        r.status === 202 || r.status === 409 || r.status === 410,
    });
  }
}

export function teardown() {
  const res = http.get(`${BASE_URL}/api/v1/metrics/cache`);
  if (res.status === 200) {
    // eslint-disable-next-line no-console
    console.log(`cache stats: ${res.body}`);
  }
}
