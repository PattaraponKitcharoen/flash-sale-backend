import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../entities/product.entity';
import { RedisService } from '../redis/redis.service';

const TTL = Number(process.env.CACHE_TTL_SECONDS ?? 5);
const REBUILD_LOCK_MS = 3000;
const REBUILD_WAIT_MS = 200;
const REBUILD_POLL_MS = 10;

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Cache-aside read path.
   *
   * The cached value is the fully serialised response body, so a cache hit
   * costs one Redis GET and zero JSON.parse/JSON.stringify work. At 1,000
   * concurrent readers that saved CPU is the difference between a p95 in the
   * teens and a p95 in the hundreds.
   */
  async getPageBody(page: number, limit: number): Promise<string> {
    const version = this.redis.productsVersion();
    const key = `products:v${version}:p${page}:l${limit}`;

    const cached = await this.redis.client.get(key);
    if (cached !== null) {
      void this.redis.client.incr(RedisService.CACHE_HIT_KEY);
      return cached;
    }
    void this.redis.client.incr(RedisService.CACHE_MISS_KEY);

    // Cache stampede guard: on a miss under load, thousands of requests would
    // otherwise hit Postgres for the same page. Only the lock winner rebuilds.
    const lockKey = `lock:rebuild:${key}`;
    const gotLock = await this.redis.client.set(
      lockKey,
      '1',
      'PX',
      REBUILD_LOCK_MS,
      'NX',
    );

    if (!gotLock) {
      const waited = await this.waitForRebuild(key);
      if (waited !== null) return waited;
      // Rebuild took too long; fall through and query directly rather than
      // making the caller wait any longer.
    }

    const body = await this.buildPageBody(page, limit);
    await this.redis.client.set(key, body, 'EX', TTL);
    if (gotLock) void this.redis.client.del(lockKey);
    return body;
  }

  private async waitForRebuild(key: string): Promise<string | null> {
    const deadline = Date.now() + REBUILD_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, REBUILD_POLL_MS));
      const value = await this.redis.client.get(key);
      if (value !== null) {
        void this.redis.client.incr(RedisService.CACHE_HIT_KEY);
        return value;
      }
    }
    return null;
  }

  private async buildPageBody(page: number, limit: number): Promise<string> {
    const [rows, total] = await this.repo.findAndCount({
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return JSON.stringify({
      status: 'success',
      data: rows.map((p) => ({
        productId: p.productId,
        name: p.name,
        price: Number(p.price),
        availableStock: p.availableStock,
        remainingStock: p.remainingStock,
        isFlashSaleActive: p.isFlashSaleActive,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }
}
