import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthedRequest } from './authed-request';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      // Verification is pure CPU (HS256) - no database, no Redis, no I/O.
      const payload = await this.jwt.verifyAsync<{ sub: string }>(
        header.slice(7),
      );
      req.userId = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    return true;
  }
}
