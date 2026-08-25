import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { Product } from '../entities/product.entity';
import { Order } from '../entities/order.entity';
import { buildBullConnection, buildRedisOptions } from '../config/redis.config';
import { RedisService } from '../redis/redis.service';
import { ORDERS_QUEUE } from '../orders/orders.constants';

interface SeedProduct {
  productId: string;
  name: string;
  description: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

async function scanDel(redis: Redis, pattern: string) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

async function main() {
  const file = join(process.cwd(), 'seed', 'products.json');
  const items = JSON.parse(readFileSync(file, 'utf8')) as SeedProduct[];

  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'admin',
    password: process.env.DB_PASS ?? 'password',
    database: process.env.DB_NAME ?? 'flashsale',
    entities: [Product, Order],
    // The seed container is the only place allowed to touch the schema.
    synchronize: true,
    logging: false,
  });
  await ds.initialize();

  // A load test must start from a known state, so every run resets both the
  // order history and the stock counters.
  await ds.query('TRUNCATE TABLE orders');
  await ds.getRepository(Product).upsert(
    items.map((p) => ({
      productId: p.productId,
      name: p.name,
      description: p.description ?? '',
      price: p.price,
      availableStock: p.availableStock,
      remainingStock: p.availableStock,
      isFlashSaleActive: p.isFlashSaleActive,
    })),
    ['productId'],
  );
  await ds.query('UPDATE products SET remaining_stock = available_stock');

  const redis = new Redis(buildRedisOptions());
  await scanDel(redis, 'products:v*');
  await scanDel(redis, 'bought:*');
  await scanDel(redis, 'lock:rebuild:*');
  await redis.del(
    RedisService.VERSION_KEY,
    RedisService.CACHE_HIT_KEY,
    RedisService.CACHE_MISS_KEY,
  );
  await redis.set(RedisService.VERSION_KEY, '1');

  // Mirror the authoritative stock into Redis. This counter is what lets the
  // API reject sold-out requests without ever reaching Postgres.
  const pipeline = redis.pipeline();
  for (const p of items) {
    pipeline.set(RedisService.stockKey(p.productId), String(p.availableStock));
  }
  await pipeline.exec();

  const queue = new Queue(ORDERS_QUEUE, { connection: buildBullConnection() });
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();

  console.log(
    `seeded ${items.length} products; p-1001 stock = ` +
      `${items.find((p) => p.productId === 'p-1001')?.availableStock}`,
  );

  await redis.quit();
  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
