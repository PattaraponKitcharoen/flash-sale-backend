import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildBullConnection } from '../config/redis.config';
import { buildTypeOrmOptions } from '../config/typeorm.config';
import { RedisModule } from '../redis/redis.module';
import { ORDERS_QUEUE } from '../orders/orders.constants';
import { OrderProcessor } from './order.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(buildTypeOrmOptions()),
    BullModule.forRoot({ connection: buildBullConnection() }),
    BullModule.registerQueue({ name: ORDERS_QUEUE }),
    RedisModule,
  ],
  providers: [OrderProcessor],
})
export class WorkerModule {}
