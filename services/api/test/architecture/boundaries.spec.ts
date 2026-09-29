// Architecture rules of eslint.config.mjs, proven to fire (ROADMAP 1.13). A green `pnpm lint`
// means either "no violations" or "the rule silently stopped working" (a plugin upgrade, a
// typo in an element pattern); these cases tell the two apart. Each bad snippet is linted as
// if it lived at `filePath`; the file itself does not exist.
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const API_ROOT = resolve(__dirname, '../..');

const ARCH_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: API_ROOT,
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
      name: 'Prisma client in domain',
      filePath: 'src/modules/orders/domain/arch-probe.ts',
      code: `import { Prisma } from '@infra/database/generated/prisma/client';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'Nest in domain',
      filePath: 'src/modules/orders/domain/arch-probe.ts',
      code: `import { Injectable } from '@nestjs/common';`,
      ruleId: 'boundaries/external',
    },
    {
      name: 'any package in domain (allow-list)',
      filePath: 'src/modules/orders/domain/arch-probe.ts',
      code: `import { Queue } from 'bullmq';`,
      ruleId: 'boundaries/external',
    },
    {
      name: 'another module internals by alias',
      filePath: 'src/modules/orders/application/arch-probe.ts',
      code: `import { CatalogService } from '@modules/catalog/catalog.service';`,
      ruleId: 'no-restricted-imports',
    },
    {
      name: 'another module internals by relative path',
      filePath: 'src/modules/orders/application/arch-probe.ts',
      code: `import { CatalogService } from '../../catalog/catalog.service';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'consumer in the core module (L4)',
      filePath: 'src/modules/orders/orders.module.ts',
      code: `import { OrdersConsumer } from './interface/worker/orders.consumer';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: 'controller in the core module (L1)',
      filePath: 'src/modules/catalog/catalog.module.ts',
      code: `import { CatalogController } from './catalog.controller';`,
      ruleId: 'boundaries/element-types',
    },
    {
      name: '@Processor outside a *.consumer.ts',
      filePath: 'src/modules/orders/application/arch-probe.ts',
      code: `@Processor('orders') export class ArchProbe {}`,
      ruleId: 'no-restricted-syntax',
    },
    {
      name: '@Controller outside a *.controller.ts',
      filePath: 'src/modules/catalog/catalog.service.ts',
      code: `@Controller('probe') export class ArchProbe {}`,
      ruleId: 'no-restricted-syntax',
    },
  ])('$name → $ruleId', async ({ filePath, code, ruleId }) => {
    const results = await eslint.lintText(code, { filePath });

    expect(ruleIdsOf(results)).toContain(ruleId);
  });
});

// guards against a rule that forbids everything: the real wiring passes
describe('the real wiring passes', () => {
  it.each([
    'src/modules/orders/domain/order.ts',
    'src/modules/orders/application/place-order.service.ts',
    'src/modules/orders/orders.module.ts',
    'src/modules/orders/orders.http.module.ts',
    'src/modules/orders/orders.worker.module.ts',
    'src/modules/orders/interface/worker/orders.consumer.ts',
    'src/modules/orders/index.ts',
    'src/modules/catalog/catalog.http.module.ts',
    'src/modules/catalog/catalog.controller.ts',
  ])('%s', async (filePath) => {
    const results = await eslint.lintFiles([filePath]);

    expect(ruleIdsOf(results)).toEqual([]);
  });
});
