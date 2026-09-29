// Process graph (principles #12, ops/process-model.md): walks the Nest module metadata of each
// entrypoint without starting it. A @Processor that reaches the api graph makes every api
// replica a queue consumer; a controller in the worker graph serves nothing. The lint rules
// catch the imports; this checks where the classes actually end up registered.
import { MODULE_METADATA } from '@nestjs/common/constants';
import { beforeAll, describe, expect, it } from 'vitest';

// relative: entrypoints have no alias, and test/ reaches them only here
import { ApiModule } from '../../src/entrypoints/api.module';
import { WorkerModule } from '../../src/entrypoints/worker.module';

// @nestjs/bullmq keeps it in dist/bull.constants.js and does not export it
const PROCESSOR_METADATA = 'bullmq:processor_metadata';

type Ctor = abstract new (...args: never[]) => unknown;

interface ModuleNode {
  name: string;
  controllers: Ctor[];
  providers: Ctor[];
}

const isCtor = (value: unknown): value is Ctor => typeof value === 'function';

const metadata = (key: string, target: object): unknown[] =>
  (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

/**
 * A class, `forwardRef(() => X)`, or a dynamic module `{ module, imports, providers }`
 * (already awaited: `ConfigModule.forRoot` returns a promise of one).
 */
function unwrapImport(entry: unknown): { module: Ctor; extra: Record<string, unknown[]> } | null {
  if (isCtor(entry)) return { module: entry, extra: {} };
  if (entry === null || typeof entry !== 'object') return null;
  if ('forwardRef' in entry && typeof entry.forwardRef === 'function') {
    return unwrapImport((entry.forwardRef as () => unknown)());
  }
  if ('module' in entry && isCtor(entry.module)) {
    const dynamic = entry as Record<string, unknown>;
    const list = (key: string): unknown[] => (Array.isArray(dynamic[key]) ? dynamic[key] : []);
    return {
      module: entry.module,
      extra: {
        imports: list('imports'),
        providers: list('providers'),
        controllers: list('controllers'),
      },
    };
  }
  return null;
}

/** `X` or `{ provide, useClass: X }`; value and factory providers carry no class. */
function providerClass(provider: unknown): Ctor | null {
  if (isCtor(provider)) return provider;
  if (provider !== null && typeof provider === 'object' && 'useClass' in provider) {
    return isCtor(provider.useClass) ? provider.useClass : null;
  }
  return null;
}

async function moduleGraph(root: Ctor): Promise<ModuleNode[]> {
  const nodes = new Map<Ctor, ModuleNode>();
  const visit = async (entry: unknown): Promise<void> => {
    const unwrapped = unwrapImport(await entry);
    if (!unwrapped) return;
    const { module, extra } = unwrapped;
    const node = nodes.get(module) ?? { name: module.name, controllers: [], providers: [] };
    const firstVisit = !nodes.has(module);
    nodes.set(module, node);

    const controllers = [
      ...(firstVisit ? metadata(MODULE_METADATA.CONTROLLERS, module) : []),
      ...(extra.controllers ?? []),
    ];
    const providers = [
      ...(firstVisit ? metadata(MODULE_METADATA.PROVIDERS, module) : []),
      ...(extra.providers ?? []),
    ];
    node.controllers.push(...controllers.filter(isCtor));
    node.providers.push(...providers.map(providerClass).filter((ctor) => ctor !== null));

    const imports = [
      ...(firstVisit ? metadata(MODULE_METADATA.IMPORTS, module) : []),
      ...(extra.imports ?? []),
    ];
    for (const imported of imports) await visit(imported);
  };
  await visit(root);
  return [...nodes.values()];
}

const isProcessor = (ctor: Ctor): boolean =>
  Reflect.getMetadata(PROCESSOR_METADATA, ctor) !== undefined;

const processorsOf = (nodes: ModuleNode[]): string[] =>
  nodes.flatMap((node) => node.providers.filter(isProcessor).map((ctor) => ctor.name));

const controllersOf = (nodes: ModuleNode[]): string[] =>
  nodes.flatMap((node) => node.controllers.map((ctor) => ctor.name));

/** Names of the modules in `graph` that declare a matching class but are not `*<suffix>`. */
const declaredOutside = (
  graph: ModuleNode[],
  suffix: string,
  declares: (node: ModuleNode) => boolean,
): string[] =>
  graph.filter((node) => declares(node) && !node.name.endsWith(suffix)).map((node) => node.name);

let apiGraph: ModuleNode[];
let workerGraph: ModuleNode[];

beforeAll(async () => {
  apiGraph = await moduleGraph(ApiModule);
  workerGraph = await moduleGraph(WorkerModule);
});

describe('api process', () => {
  it('registers no queue consumer', () => {
    expect(processorsOf(apiGraph)).toEqual([]);
  });

  it('declares controllers only in *HttpModule', () => {
    expect(declaredOutside(apiGraph, 'HttpModule', (node) => node.controllers.length > 0)).toEqual(
      [],
    );
  });

  it('serves the controllers of every module (the walk is not vacuous)', () => {
    expect(controllersOf(apiGraph)).toEqual(
      expect.arrayContaining(['IdentityController', 'CatalogController', 'OrdersController']),
    );
  });
});

describe('worker process', () => {
  it('serves no HTTP', () => {
    expect(controllersOf(workerGraph)).toEqual([]);
  });

  it('declares @Processor classes only in *WorkerModule', () => {
    expect(
      declaredOutside(workerGraph, 'WorkerModule', (node) => node.providers.some(isProcessor)),
    ).toEqual([]);
  });

  it('registers the orders consumer (the walk is not vacuous)', () => {
    expect(processorsOf(workerGraph)).toEqual(['OrdersConsumer']);
  });
});
