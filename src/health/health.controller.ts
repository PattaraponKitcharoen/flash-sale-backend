import { Controller, Get } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Controller()
export class HealthController {
  constructor(private readonly redis: RedisService) {}

  @Get('health')
  health() {
    return { status: 'ok', instance: process.env.HOSTNAME ?? 'local' };
  }

  /** Cache hit / miss ratio for the report's observability section. */
  @Get('metrics/cache')
  cache() {
    return this.redis.cacheStats();
  }

  @Get('metrics/cache/reset')
  async reset() {
    await this.redis.client.del(
      RedisService.CACHE_HIT_KEY,
      RedisService.CACHE_MISS_KEY,
    );
    return { status: 'success' };
  }
}
