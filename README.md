# Flash Sale Backend

NestJS + Fastify backend for a high-concurrency flash sale, built to the
assignment spec: Nginx load balancing across three API instances, PostgreSQL
with TypeORM, Redis caching, and BullMQ for asynchronous order processing.

## Quick start

```bash
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| API (through Nginx) | http://localhost |
| Bull-Board queue dashboard | http://localhost:3001/admin/queues |
| Cache hit/miss metrics | http://localhost/api/v1/metrics/cache |

The `seed` container runs once, creates the schema, loads
`seed/products.json` (20 products, `p-1001` limited to 50 units), and mirrors
the stock into Redis. The API containers only start after it exits cleanly.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/token` | `{ "userId": "user-999" }` → HS256 JWT |
| GET | `/api/v1/products?page=1&limit=10` | Cache-aside, paginated |
| POST | `/api/v1/orders` | Bearer JWT, `{ "productId": "p-1001" }` → `202` |

Order responses:

- `202 Accepted` — reservation claimed, job queued
- `409 Conflict` — this user already reserved this product
- `410 Gone` — sold out
- `401 Unauthorized` — missing or invalid JWT

## How the write path stays fast

`POST /api/v1/orders` never issues SQL. It verifies the JWT (pure CPU), runs a
single Lua script on Redis, pushes a BullMQ job, and returns `202`.

The Lua script in `src/redis/redis.service.ts` does the duplicate check and the
stock decrement atomically in one round trip:

1. `SISMEMBER bought:<productId> <userId>` → already claimed, return `-1`
2. `GET stock:<productId>` → zero or missing, return `-2` / `-3`
3. `SADD` the user, `DECR` the counter, roll both back if it went negative

Because the counter lives in Redis, users 51 through 500 are rejected at the
API edge. Only 50 jobs ever reach the queue, the worker, or Postgres.

## How stock never goes negative

The worker (`src/worker/order.processor.ts`) runs one conditional UPDATE inside
a transaction:

```sql
UPDATE products
   SET remaining_stock = remaining_stock - 1
 WHERE product_id = $1 AND remaining_stock > 0
RETURNING remaining_stock;
```

Zero rows returned means the product is gone, and the job fails as
`SOLD_OUT`. Postgres takes the row lock itself, so this is both the race
condition fix and the cheapest option — no separate `SELECT ... FOR UPDATE`
round trip.

The insert that follows relies on the unique constraint
`uq_orders_user_product` on `(user_id, product_id)`. If it conflicts, the whole
transaction rolls back, including the decrement, and the job fails as
`DUPLICATE_ORDER`. Both failure kinds are visible in Bull-Board.

## Cache invalidation strategy

Cached pages are keyed by a version number: `products:v<N>:p<page>:l<limit>`.
When the worker commits a stock change it runs `INCR products:ver`, which
instantly orphans every cached page — an O(1) operation. `KEYS`/`SCAN` based
invalidation is deliberately avoided because it blocks Redis for every other
in-flight request. Old entries expire on their own five-second TTL.

Two further read-path optimisations:

- The cache stores the fully serialised response body, so a hit costs one
  Redis `GET` and no JSON parsing or re-serialisation.
- A `SET NX PX` rebuild lock prevents a cache stampede: on a miss under load
  only one request queries Postgres while the rest briefly wait for the
  rebuilt entry.

## Load balancing

`nginx.conf` uses `least_conn` because the two endpoints have very different
service times (cached reads around 2 ms, queued writes around 15 ms) and round
robin would pile writes onto the same instance. Also important:

- `keepalive 128` plus `proxy_http_version 1.1` and `proxy_set_header
  Connection ""` — without these Nginx opens a fresh TCP connection per
  request and latency collapses at 1,000 concurrent users.
- `max_fails=0` — 409 and 410 are expected business responses, and without
  this Nginx would evict healthy instances mid-test.

## Load testing

```bash
k6 run k6/loadtest.js
```

Useful environment variables:

```bash
k6 run -e BASE_URL=http://<other-team-host> k6/loadtest.js
```

The script mints 500 JWTs in `setup()` (so authentication is excluded from the
measurements), then runs 1,000 concurrent readers against `/products` and 500
concurrent writers against `/orders`. Every fifth user fires three simultaneous
requests to exercise the duplicate protection.

## Verifying data integrity after a run

```bash
docker compose exec postgres psql -U admin -d flashsale -c \
  "SELECT remaining_stock FROM products WHERE product_id = 'p-1001';"

docker compose exec postgres psql -U admin -d flashsale -c \
  "SELECT COUNT(*) AS orders, COUNT(DISTINCT user_id) AS distinct_users
     FROM orders WHERE product_id = 'p-1001';"
```

Expected: `remaining_stock = 0`, and 50 orders across 50 distinct users.

## Resetting between runs

```bash
docker compose run --rm seed
```
