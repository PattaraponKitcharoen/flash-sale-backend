import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Order } from '../entities/order.entity';
import { Product } from '../entities/product.entity';

export function buildTypeOrmOptions(): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'admin',
    password: process.env.DB_PASS ?? 'password',
    database: process.env.DB_NAME ?? 'flashsale',
    entities: [Product, Order],
    // Schema is created once by the seed container, never by the API pods.
    synchronize: false,
    logging: false,
    extra: {
      // An oversized pool makes Postgres slower, not faster: it just adds
      // context switching. 20 per container across 6 containers = 120 conns.
      max: Number(process.env.DB_POOL_MAX ?? 20),
      min: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
  };
}
