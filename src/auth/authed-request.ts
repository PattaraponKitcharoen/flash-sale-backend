import type { FastifyRequest } from 'fastify';

/** Fastify request after JwtAuthGuard has attached the verified subject. */
export type AuthedRequest = FastifyRequest & { userId: string };
