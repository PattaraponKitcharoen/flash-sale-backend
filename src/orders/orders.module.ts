import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller';
import { ORDERS_QUEUE } from './orders.constants';

@Module({
  imports: [BullModule.registerQueue({ name: ORDERS_QUEUE })],
  controllers: [OrdersController],
})
export class OrdersModule {}
