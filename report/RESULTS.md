# Load Test Results

Measured on the developer machine, all containers on one Docker host
(3 API instances + 1 worker + Nginx + PostgreSQL + Redis). k6 ran inside the
same Docker network to keep the client off the Windows loopback stack.

Command:

```bash
docker compose --profile loadtest run --rm k6
```

## Run A — full load (1,000 concurrent readers + 500 concurrent writers)

| Metric | Before optimisation | After optimisation |
| --- | --- | --- |
| Throughput | 19,688 req/s | **20,661 req/s** |
| Read p95 | 65.15 ms | **62.35 ms** |
| Read median | 45.45 ms | 42.76 ms |
| Order p95 | 2.19 s | 2.43 s |
| Order median | 151.92 ms | 126.74 ms |
| Cache hit ratio | 99.35 % | 99.3 % |
| Checks passed | 100 % | 100 % |
| Total requests | 600,494 | 628,897 |

The optimisation between the two runs replaced the per-request `GET
products:ver` with a push-based local mirror: the worker publishes each
version bump on a Redis channel and every API instance keeps its own copy
(with a one second poll as a safety net). That removes one Redis round trip
from every single cache hit.

## Run B — write path in isolation (read load reduced to 1 VU)

The order burst in Run A is measured while 1,000 readers already saturate the
host CPU, so its tail reflects queueing at the edge rather than the handler.
Re-running with the read load removed isolates the write path itself:

| Metric | Value |
| --- | --- |
| Order p95 | **142.04 ms** |
| Order median | 94.79 ms |
| Order min | 29.31 ms |
| Read p95 | **0.65 ms** |
| Read median | 0.43 ms |

700 order requests are fired simultaneously (500 users, every fifth one
double-tapping with three parallel requests) and the slowest is answered in
166 ms.

## Order outcomes

Identical across every run, which is the point:

| Outcome | Count |
| --- | --- |
| `202 Accepted` | **50** |
| `409 Conflict` (duplicate user) | 28–31 |
| `410 Gone` (sold out) | 617–622 |
| Unexpected status | **0** |

`http_req_failed` reports roughly 0.1 % under full load; those are the 409 and
410 responses, which k6 counts as failures by default. They are the correct
business answers, not errors — hence the `checks` threshold instead.

## Data integrity proof

```
SELECT remaining_stock FROM products WHERE product_id='p-1001';
 remaining_stock
-----------------
               0

SELECT COUNT(*) AS orders, COUNT(DISTINCT user_id) AS distinct_users,
       MAX(c) AS max_per_user
  FROM (SELECT user_id, COUNT(*) c FROM orders
         WHERE product_id='p-1001' GROUP BY user_id) t;
 orders | distinct_users | max_per_user
--------+----------------+--------------
     50 |             50 |            1
```

500 users raced for 50 units, 100 of them fired three requests at once, and
the result is exactly 50 orders held by 50 distinct users with no user holding
more than one and no negative stock.

## Where the time goes

- A cache hit is one Redis `GET` returning an already-serialised body: no
  JSON parsing, no re-serialisation, no database contact.
- A `POST /orders` that will be rejected (duplicate or sold out) never leaves
  Redis. Only the 50 winning requests reach the queue, the worker, and
  Postgres — the other 650 are stopped at the edge.
- The worker is a separate container, so queue processing never competes with
  the HTTP path for CPU.
