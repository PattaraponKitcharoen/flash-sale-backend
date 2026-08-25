import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { getQueueToken } from '@nestjs/bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter as BullBoardAdapter } from '@bull-board/fastify';
import { Queue } from 'bullmq';
import type { FastifyRegisterOptions } from 'fastify';
import { WorkerModule } from './worker/worker.module';
import { ORDERS_QUEUE } from './orders/orders.constants';

const BASE_PATH = '/admin/queues';

async function bootstrap() {
  // The worker runs in its own container so queue processing never competes
  // with the HTTP path for CPU.
  const app = await NestFactory.create<NestFastifyApplication>(
    WorkerModule,
    new FastifyAdapter({ logger: false }),
    { logger: ['error', 'warn', 'log'] },
  );

  const queue = app.get<Queue>(getQueueToken(ORDERS_QUEUE));

  const serverAdapter = new BullBoardAdapter();
  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter,
  });
  serverAdapter.setBasePath(BASE_PATH);

  const fastify = app.getHttpAdapter().getInstance();
  // basePath is a bull-board plugin option, not part of Fastify's own
  // register typings.
  const bullBoardOptions: Record<string, unknown> = {
    prefix: BASE_PATH,
    basePath: BASE_PATH,
  };
  await fastify.register(
    serverAdapter.registerPlugin(),
    bullBoardOptions as FastifyRegisterOptions<Record<never, never>>,
  );

  const port = Number(process.env.WORKER_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`Bull-Board listening on http://localhost:${port}${BASE_PATH}`);
}

void bootstrap();
