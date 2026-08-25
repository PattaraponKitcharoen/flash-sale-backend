import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  GoneException,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthedRequest } from '../auth/authed-request';
import { ORDERS_QUEUE, ORDER_JOB, OrderJobData } from './orders.constants';
import {
  RESERVE_DUPLICATE,
  RESERVE_SOLD_OUT,
  RESERVE_UNKNOWN_PRODUCT,
  RedisService,
} from '../redis/redis.service';

@Controller('orders')
export class OrdersController {
  constructor(
    @InjectQueue(ORDERS_QUEUE) private readonly queue: Queue<OrderJobData>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Write path. Everything here is O(1) in-memory work: verify the JWT, run
   * one Lua script against Redis, push a job, answer 202. No SQL is issued on
   * this thread - the worker owns the durable write.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(202)
  async create(
    @Req() req: AuthedRequest,
    @Body() body: { productId?: string },
  ) {
    const productId = body?.productId;
    if (typeof productId !== 'string' || productId.length === 0) {
      throw new BadRequestException('productId is required');
    }
    const userId = req.userId;

    // Single atomic claim: duplicate detection and stock decrement together.
    // Everyone past the stock limit is rejected right here and never reaches
    // the queue or the database.
    const result = await this.redis.reserve(productId, userId);

    if (result === RESERVE_DUPLICATE) {
      throw new ConflictException('User already reserved this product');
    }
    if (result === RESERVE_SOLD_OUT) {
      throw new GoneException('Product is sold out');
    }
    if (result === RESERVE_UNKNOWN_PRODUCT) {
      throw new NotFoundException('Unknown product');
    }

    const job = await this.queue.add(
      ORDER_JOB,
      { userId, productId },
      {
        // Deterministic id makes a duplicate enqueue a no-op even if the
        // Redis claim were somehow bypassed. BullMQ rejects ':' in custom ids.
        jobId: `${productId}__${userId}`,
        removeOnComplete: true,
        removeOnFail: 1000,
        attempts: 3,
        backoff: { type: 'fixed', delay: 200 },
      },
    );

    return {
      status: 'processing',
      orderJobId: job.id,
      message: 'Your order is in the queue.',
    };
  }
}
