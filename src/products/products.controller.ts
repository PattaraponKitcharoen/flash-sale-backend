import { Controller, Get, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ProductsService } from './products.service';

function toInt(raw: unknown, fallback: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(
    @Query('page') pageRaw: string,
    @Query('limit') limitRaw: string,
    @Res() reply: FastifyReply,
  ) {
    const page = toInt(pageRaw, 1, 1, 10_000);
    const limit = toInt(limitRaw, 10, 1, 100);

    // Send the cached string straight through - re-parsing it just to let the
    // framework serialise it again would double the CPU cost of a cache hit.
    const body = await this.products.getPageBody(page, limit);
    reply.header('content-type', 'application/json; charset=utf-8').send(body);
  }
}
