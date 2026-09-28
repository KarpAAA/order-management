import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { allConfigs } from './configuration';
import { validateEnv } from './env.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      // tests get their env from .env.test via vitest; a developer's .env must not leak in
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      load: allConfigs,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
