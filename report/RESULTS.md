# Load Test Results

Measured on the developer machine, all containers on one Docker host
(3 API instances + 1 worker + Nginx + PostgreSQL + Redis). k6 ran inside the
same Docker network to keep the client off the Windows loopback stack.

```bash
docker compose run --rm seed      # reset stock to a known state
docker compose --profile loadtest run --rm k6
```

## Test shape

Both scenarios are **fixed work**, so the elapsed time is itself a result
rather than something the script dictates:

| Scenario | Load | Ends when |
| --- | --- | --- |
| `read_load` | 1,000 concurrent users x 100 requests = 100,000 GETs | the work is done |
| `write_load` | 500 concurrent users, every 5th firing 3x = 700 POSTs | the work is done |

The write burst starts one second in, so it lands while the readers are
already saturating the host.

## Completion time

```
  █ WORKLOAD COMPLETION TIME

    read  : 1000 concurrent users x 100 requests
            100000 requests in 3.87s (3868 ms)
            25853 req/s

    write : 500 concurrent users (every 5th fires 3x)
            700 requests in 0.26s (262 ms)
            2672 req/s

    total run: 4.19s (4193 ms)
```

## Latency and throughput

| Metric | Value |
| --- | --- |
| Read p95 | **58.92 ms** |
| Read median | 26.10 ms |
| Read min | 0.43 ms |
| Order p95 | **58.45 ms** |
| Order median | 37.97 ms |
| Overall throughput | 24,137 req/s |
| Cache hit ratio | **98.38 %** |
| Checks passed | 100 % (200,700 of 200,700) |
| Interrupted iterations | 0 |

`http_req_failed` reports 0.64 %; those 650 responses are the 409 and 410
answers, which k6 counts as failures by default. They are the correct business
outcomes, not errors — hence the `checks` threshold instead.

## Order outcomes

| Outcome | Count |
| --- | --- |
| `202 Accepted` | **50** |
| `409 Conflict` (duplicate user) | 25 |
| `410 Gone` (sold out) | 625 |
| Unexpected status | **0** |

50 + 25 + 625 = 700, the exact number of requests sent.

## Data integrity proof

```
 stock | orders | users | max_per_user
-------+--------+-------+--------------
     0 |     50 |    50 |            1
```

500 users raced for 50 units, 100 of them fired three requests at once, and
the result is exactly 50 orders held by 50 distinct users with no user holding
more than one and no negative stock.

## Optimisation history

An earlier revision read `products:ver` from Redis on every request. Replacing
that with a push-based local mirror — the worker publishes each version bump
on a Redis channel and every API instance keeps its own copy, with a one
second poll as a safety net — removed one Redis round trip from every cache
hit and lifted throughput from 19,688 to 20,661 req/s on an otherwise
identical duration-based run.

## Where the time goes

- A cache hit is one Redis `GET` returning an already-serialised body: no
  JSON parsing, no re-serialisation, no database contact.
- A `POST /orders` that will be rejected (duplicate or sold out) never leaves
  Redis. Only the 50 winning requests reach the queue, the worker, and
  Postgres — the other 650 are stopped at the edge.
- The worker is a separate container, so queue processing never competes with
  the HTTP path for CPU.

## Tuning the run

```bash
# heavier read workload
docker compose --profile loadtest run --rm -e READ_ITERATIONS=500 k6

# write path in isolation
docker compose --profile loadtest run --rm -e READ_ITERATIONS=1 k6

# another team's deployment
docker compose --profile loadtest run --rm -e BASE_URL=http://192.168.1.50 k6
```
