// Architecture rules of eslint.config.mjs, proven to fire. A green `pnpm lint` means either
// "no violations" or "the rule silently stopped working" (a plugin upgrade, a typo in an
// element pattern); these cases tell the two apart. Each bad snippet is linted as if it lived
// at `filePath`; the file itself does not exist.
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

const ARCH_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: ROOT,
    // virtual files are outside the tsconfig program; the architecture rules need no types
    overrideConfig: tseslint.configs.disableTypeChecked,
    ruleFilter: ({ ruleId }) => ruleId.startsWith('boundaries/') || ARCH_RULES.has(ruleId),
  });
});

const ruleIdsOf = (results: ESLint.LintResult[]): (string | null)[] =>
  results.flatMap((result) => result.messages.map((message) => message.ruleId));

describe('violations fail lint', () => {
  it.each([
    {
      name: 'consumer in the core module',
      filePath: 'src/modules/notifications/notifications.module.ts',
      code: `import { OrderEventsConsumer } from './interface/worker/order-events.consumer';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'a job that starts on its own in the core module',
      filePath: 'src/modules/notifications/notifications.module.ts',
      code: `import { DispatchNotificationsJob } from './interface/worker/dispatch-notifications.job';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: '@RabbitSubscribe outside a *.consumer.ts',
      filePath: 'src/modules/notifications/application/request-notification.service.ts',
      code: `export class ArchProbe { @RabbitSubscribe({ queue: 'q' }) handle() {} }`,
      ruleId: 'no-restricted-syntax',
    },
    {
      name: 'the message contracts in a port',
      filePath: 'src/modules/notifications/ports/arch-probe.port.ts',
      code: `import { OrderPaidV1 } from '@oms/contracts';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'the message contracts in the use case',
      filePath: 'src/modules/notifications/application/request-notification.service.ts',
      code: `import { OrderPaidV1 } from '@oms/contracts';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'Nest in the domain',
      filePath: 'src/modules/notifications/domain/arch-probe.ts',
      code: `import { Injectable } from '@nestjs/common';`,
      ruleId: 'boundaries/external',
    },
    {
      name: 'the mail library in a use case',
      filePath: 'src/modules/notifications/application/arch-probe.service.ts',
      code: `import { SmtpMailerAdapter } from '../infrastructure/smtp-mailer.adapter';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'the database in a use case',
      filePath: 'src/modules/notifications/application/arch-probe.service.ts',
      code: `import { PrismaService } from '@infra/database/prisma.service';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'Nest in a port',
      filePath: 'src/modules/notifications/ports/arch-probe.port.ts',
      code: `import { Injectable } from '@nestjs/common';`,
      ruleId: 'boundaries/external',
    },
  ])('$name → $ruleId', async ({ filePath, code, ruleId }) => {
    const results = await eslint.lintText(code, { filePath });

    expect(ruleIdsOf(results)).toContain(ruleId);
  });
});

// guards against a rule that forbids everything: the real wiring passes
describe('the real wiring passes', () => {
  it.each([
    'src/entrypoints/worker.module.ts',
    'src/modules/notifications/notifications.module.ts',
    'src/modules/notifications/notifications.worker.module.ts',
    'src/modules/notifications/interface/worker/order-events.consumer.ts',
    'src/modules/notifications/interface/worker/dispatch-notifications.job.ts',
    'src/modules/notifications/interface/worker/cleanup-notifications.job.ts',
    'src/modules/notifications/application/request-notification.service.ts',
    'src/modules/notifications/application/dispatch-notification.service.ts',
    'src/modules/notifications/domain/notification.ts',
    'src/modules/notifications/domain/templates.ts',
    'src/modules/notifications/ports/mailer.port.ts',
    'src/modules/notifications/ports/notifications-repository.port.ts',
    'src/modules/notifications/infrastructure/notifications.repository.ts',
    'src/modules/notifications/infrastructure/smtp-mailer.adapter.ts',
    'src/modules/notifications/infrastructure/notifications-cleanup.ts',
    'src/infrastructure/inbox/inbox.worker.module.ts',
    'src/infrastructure/inbox/postgres-inbox.ts',
    'src/modules/notifications/index.ts',
  ])('%s', async (filePath) => {
    const results = await eslint.lintFiles([filePath]);

    expect(ruleIdsOf(results)).toEqual([]);
  });
});
