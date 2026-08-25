import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildBullConnection } from './config/redis.config';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(buildTypeOrmOptions()),
    BullModule.forRoot({ connection: buildBullConnection() }),
    RedisModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
    HealthModule,
  ],
})
export class AppModule {}
