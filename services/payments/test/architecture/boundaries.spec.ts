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
      filePath: 'src/modules/payments/payments.module.ts',
      code: `import { PaymentsConsumer } from './payments.consumer';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: '@RabbitSubscribe outside a *.consumer.ts',
      filePath: 'src/modules/payments/charge-payment.service.ts',
      code: `export class ArchProbe { @RabbitSubscribe({ queue: 'q' }) handle() {} }`,
      ruleId: 'no-restricted-syntax',
    },
    {
      name: 'the message contracts in a port',
      filePath: 'src/modules/payments/ports/arch-probe.port.ts',
      code: `import { ChargePaymentV1 } from '@oms/contracts';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'the message contracts in the use case',
      filePath: 'src/modules/payments/charge-payment.service.ts',
      code: `import { ChargePaymentV1 } from '@oms/contracts';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'Nest in a port',
      filePath: 'src/modules/payments/ports/arch-probe.port.ts',
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
    'src/modules/payments/payments.module.ts',
    'src/modules/payments/payments.worker.module.ts',
    'src/modules/payments/payments.consumer.ts',
    'src/modules/payments/charge-payment.service.ts',
    'src/modules/payments/infrastructure/outbox-payment-events.adapter.ts',
    'src/infrastructure/outbox/outbox.worker.module.ts',
    'src/infrastructure/outbox/outbox-relay.ts',
    'src/modules/payments/index.ts',
  ])('%s', async (filePath) => {
    const results = await eslint.lintFiles([filePath]);

    expect(ruleIdsOf(results)).toEqual([]);
  });
});
