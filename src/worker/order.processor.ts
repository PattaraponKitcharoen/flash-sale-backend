import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import { ORDERS_QUEUE, OrderJobData } from '../orders/orders.constants';
import { RedisService } from '../redis/redis.service';

@Processor(ORDERS_QUEUE, {
  concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 16),
})
export class OrderProcessor extends WorkerHost {
  private readonly log = new Logger(OrderProcessor.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<OrderJobData>) {
    const { userId, productId } = job.data;

    try {
      const remaining = await this.ds.transaction(async (m) => {
        // A single conditional UPDATE is both the race-condition fix and the
        // fastest option available: Postgres takes the row lock itself, and
        // the WHERE clause makes a negative stock impossible. This beats
        // SELECT ... FOR UPDATE followed by a second statement.
        const updated: Array<{ remaining_stock: number }> = await m.query(
          `UPDATE products
              SET remaining_stock = remaining_stock - 1
            WHERE product_id = $1
              AND remaining_stock > 0
        RETURNING remaining_stock`,
          [productId],
        );

        if (updated.length === 0) {
          throw new SoldOutError();
        }

        // Final safety net: the unique constraint on (user_id, product_id)
        // means a second reservation can never be persisted, whatever the
        // upstream layers did.
        const inserted: Array<{ id: string }> = await m.query(
          `INSERT INTO orders (user_id, product_id, quantity, status, job_id)
           VALUES ($1, $2, 1, 'CONFIRMED', $3)
           ON CONFLICT ON CONSTRAINT uq_orders_user_product DO NOTHING
        RETURNING id`,
          [userId, productId, String(job.id)],
        );

        if (inserted.length === 0) {
          // Throwing rolls back the decrement above as well.
          throw new DuplicateOrderError();
        }

        return Number(updated[0].remaining_stock);
      });

      // The database is now the source of truth again, so every cached page
      // must be considered stale. INCR on the version key is O(1) and never
      // blocks Redis the way KEYS/SCAN would.
      await this.redis.bumpProductsVersion();

      return { userId, productId, remainingStock: remaining };
    } catch (err) {
      if (err instanceof SoldOutError) {
        // Give the reservation slot back but do not restore the counter -
        // the database says there is genuinely nothing left.
        await this.redis.client.srem(RedisService.boughtKey(productId), userId);
        await this.syncStockCounter(productId);
        throw new UnrecoverableError('SOLD_OUT');
      }
      if (err instanceof DuplicateOrderError) {
        // This job consumed no stock, so hand the unit back to the pool.
        await this.redis.release(productId, userId);
        throw new UnrecoverableError('DUPLICATE_ORDER');
      }
      this.log.error(`job ${job.id} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private async syncStockCounter(productId: string) {
    const rows: Array<{ remaining_stock: number }> = await this.ds.query(
      'SELECT remaining_stock FROM products WHERE product_id = $1',
      [productId],
    );
    if (rows.length > 0) {
      await this.redis.client.set(
        RedisService.stockKey(productId),
        String(rows[0].remaining_stock),
      );
    }
  }
}

class SoldOutError extends Error {}
class DuplicateOrderError extends Error {}
