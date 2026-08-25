import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'flash-sale-dev-secret-change-me',
      signOptions: {
        algorithm: 'HS256',
        // @nestjs/jwt types expiresIn as a ms template literal; the value
        // comes from the environment, so widen it once here.
        expiresIn: (process.env.JWT_EXPIRES_IN ?? '1h') as unknown as number,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
