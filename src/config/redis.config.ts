import type { ConnectionOptions as BullConnectionOptions } from 'bullmq';
import { RedisOptions } from 'ioredis';

export function buildRedisOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    // Batches commands issued in the same tick into one round trip; this is
    // the single biggest Redis win under high concurrency.
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  };
}

/**
 * BullMQ ships its own structural RedisOptions interface that does not line up
 * with the one from ioredis, so the shared config is handed over explicitly.
 */
export function buildBullConnection(): BullConnectionOptions {
  return buildRedisOptions() as unknown as BullConnectionOptions;
}
