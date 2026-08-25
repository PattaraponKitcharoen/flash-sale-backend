import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { buildRedisOptions } from '../config/redis.config';

export const RESERVE_OK = 0;
export const RESERVE_DUPLICATE = -1;
export const RESERVE_SOLD_OUT = -2;
export const RESERVE_UNKNOWN_PRODUCT = -3;

/**
 * Atomically claims one unit of a product for a user.
 *
 * This is the hot path of the whole system. Doing the duplicate check and the
 * stock decrement inside one Lua script means a single Redis round trip, and
 * it means users 51..500 are rejected here without ever touching the queue,
 * the worker, or Postgres.
 *
 * KEYS[1] = bought:<productId>   (set of userIds that already hold a claim)
 * KEYS[2] = stock:<productId>    (integer counter mirroring remaining_stock)
 * ARGV[1] = userId
 *
 * Returns the remaining stock (>= 0) on success, or a negative status code.
 */
const RESERVE_SCRIPT = `
local claimed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if claimed == 1 then
  return -1
end
local stock = redis.call('GET', KEYS[2])
if not stock then
  return -3
end
if tonumber(stock) <= 0 then
  return -2
end
redis.call('SADD', KEYS[1], ARGV[1])
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2
end
return left
`;

/**
 * Gives a claim back when the worker could not honour it (product sold out in
 * the database, or the job failed permanently).
 */
const RELEASE_SCRIPT = `
if redis.call('SREM', KEYS[1], ARGV[1]) == 1 then
  return redis.call('INCR', KEYS[2])
end
return -1
`;

/** ioredis custom commands registered via defineCommand below. */
interface RedisWithScripts extends Redis {
  reserveStock(
    boughtKey: string,
    stockKey: string,
    userId: string,
  ): Promise<number>;
  releaseStock(
    boughtKey: string,
    stockKey: string,
    userId: string,
  ): Promise<number>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: RedisWithScripts;

  /**
   * Push-based mirror of products:ver.
   *
   * Reading the version from Redis on every request would double the round
   * trips on the hottest path in the system. Instead the worker publishes
   * each bump and every API instance keeps a local copy, with a one second
   * poll as a safety net in case a message is ever missed.
   */
  private cachedVersion = '1';
  private subscriber?: Redis;
  private refreshTimer?: NodeJS.Timeout;

  constructor() {
    this.client = new Redis(buildRedisOptions()) as RedisWithScripts;
    this.client.defineCommand('reserveStock', {
      numberOfKeys: 2,
      lua: RESERVE_SCRIPT,
    });
    this.client.defineCommand('releaseStock', {
      numberOfKeys: 2,
      lua: RELEASE_SCRIPT,
    });
  }

  static stockKey(productId: string) {
    return `stock:${productId}`;
  }

  static boughtKey(productId: string) {
    return `bought:${productId}`;
  }

  static readonly VERSION_KEY = 'products:ver';
  static readonly VERSION_CHANNEL = 'products:ver:changed';
  static readonly CACHE_HIT_KEY = 'metrics:cache:hit';
  static readonly CACHE_MISS_KEY = 'metrics:cache:miss';

  reserve(productId: string, userId: string): Promise<number> {
    return this.client.reserveStock(
      RedisService.boughtKey(productId),
      RedisService.stockKey(productId),
      userId,
    );
  }

  release(productId: string, userId: string): Promise<number> {
    return this.client.releaseStock(
      RedisService.boughtKey(productId),
      RedisService.stockKey(productId),
      userId,
    );
  }

  async onModuleInit() {
    await this.client.set(RedisService.VERSION_KEY, '1', 'NX');
    await this.syncVersion();

    this.subscriber = new Redis(buildRedisOptions());
    await this.subscriber.subscribe(RedisService.VERSION_CHANNEL);
    this.subscriber.on('message', (_channel, message) => {
      if (message) this.cachedVersion = message;
    });

    this.refreshTimer = setInterval(() => {
      void this.syncVersion();
    }, 1000);
    this.refreshTimer.unref();
  }

  private async syncVersion() {
    const v = await this.client.get(RedisService.VERSION_KEY);
    if (v !== null) this.cachedVersion = v;
  }

  /**
   * Cache invalidation by version bump: O(1), and it never runs KEYS/SCAN,
   * which would block Redis for every other request in flight. Stale entries
   * simply fall out on their own TTL because nothing reads the old version.
   */
  async bumpProductsVersion(): Promise<number> {
    const next = await this.client.incr(RedisService.VERSION_KEY);
    await this.client.publish(RedisService.VERSION_CHANNEL, String(next));
    return next;
  }

  /** Local, allocation-free read of the current cache generation. */
  productsVersion(): string {
    return this.cachedVersion;
  }

  async cacheStats() {
    const [hit, miss] = await this.client.mget(
      RedisService.CACHE_HIT_KEY,
      RedisService.CACHE_MISS_KEY,
    );
    const h = Number(hit ?? 0);
    const m = Number(miss ?? 0);
    const total = h + m;
    return {
      hits: h,
      misses: m,
      total,
      hitRatio: total === 0 ? 0 : Number(((h / total) * 100).toFixed(2)),
    };
  }

  async onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.subscriber?.quit().catch(() => undefined);
    await this.client.quit().catch(() => undefined);
  }
}
