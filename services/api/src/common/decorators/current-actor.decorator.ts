import { createParamDecorator, UnauthorizedException } from '@nestjs/common';

import type { UserActor } from '@shared/auth/actor';

import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestWithActor extends Request {
  actor?: UserActor;
}

/** The `UserActor` built by `AuthGuard`. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): UserActor => {
  const actor = ctx.switchToHttp().getRequest<RequestWithActor>().actor;
  // Only reachable on a @Public() route that asks for an actor: a programming error.
  if (!actor) throw new UnauthorizedException('Authentication required');
  return actor;
});
