import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { authConfig, type AuthConfig } from '@config/configuration';
import { userActor } from '@shared/auth/actor';

import { IS_PUBLIC } from '../decorators/public.decorator';

import type { RequestWithActor } from '../decorators/current-actor.decorator';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

interface AccessTokenPayload {
  sub: string;
}

/**
 * Global and fail-closed: every route needs a valid bearer token unless it is `@Public()`.
 * The only place that reads the token; it turns it into a `UserActor`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
      });
      request.actor = userActor(payload.sub);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
