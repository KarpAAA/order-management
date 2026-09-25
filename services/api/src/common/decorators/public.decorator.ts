import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/** Opts a route out of the global `AuthGuard`. Everything else requires a valid token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
