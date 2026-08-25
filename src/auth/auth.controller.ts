import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Controller('auth')
export class AuthController {
  constructor(private readonly jwt: JwtService) {}

  /**
   * Simulated login. No database lookup on purpose: this endpoint is only a
   * fixture for the load test and must never become a bottleneck.
   */
  @Post('token')
  @HttpCode(200)
  async token(@Body() body: { userId?: string }) {
    const userId = body?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new BadRequestException('userId is required');
    }
    return {
      status: 'success',
      accessToken: await this.jwt.signAsync({ sub: userId }),
    };
  }
}
