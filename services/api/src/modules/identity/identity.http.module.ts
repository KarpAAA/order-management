// transport · http
import { Module } from '@nestjs/common';

import { IdentityController } from './identity.controller';
import { IdentityModule } from './identity.module';

@Module({
  imports: [IdentityModule],
  controllers: [IdentityController],
})
export class IdentityHttpModule {}
