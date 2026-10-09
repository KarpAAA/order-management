// Process graph (principles #12, ops/process-model.md): walks the Nest module metadata of the
// entrypoint without starting it. A class with a @RabbitSubscribe method starts consuming in
// every process that registers it, so it may be declared in a *WorkerModule only. The lint
// rules catch the imports; this checks where the classes actually end up registered.
import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { beforeAll, describe, expect, it } from 'vitest';

// relative: entrypoints have no alias, and test/ reaches them only here
import { WorkerModule } from '../../src/entrypoints/worker.module';

type Ctor = abstract new (...args: never[]) => unknown;

interface ModuleNode {
  name: string;
  controllers: Ctor[];
  providers: Ctor[];
}

const isCtor = (value: unknown): value is Ctor => typeof value === 'function';

const metadata = (key: string, target: object): unknown[] =>
  (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

/** A class, or a dynamic module `{ module, imports, providers }` (already awaited). */
function unwrapImport(entry: unknown): { module: Ctor; extra: Record<string, unknown[]> } | null {
  if (isCtor(entry)) return { module: entry, extra: {} };
  if (entry === null || typeof entry !== 'object') return null;
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

/** A class with at least one @RabbitSubscribe method. */
const isSubscriber = (ctor: Ctor): boolean => {
  const prototype = ctor.prototype as Record<string, unknown> | undefined;
  if (!prototype) return false;
  return Object.getOwnPropertyNames(prototype).some((name) => {
    const method = Object.getOwnPropertyDescriptor(prototype, name)?.value as unknown;
    return (
      typeof method === 'function' && Reflect.getMetadata(RABBIT_HANDLER, method) !== undefined
    );
  });
};

/** What starts working on its own besides a consumer: the dispatcher and the two cleanups. */
const RUNNERS = ['DispatchNotificationsJob', 'CleanupNotificationsJob', 'InboxCleanupRunner'];

let graph: ModuleNode[];

beforeAll(async () => {
  graph = await moduleGraph(WorkerModule);
});

describe('worker process', () => {
  it('serves no HTTP', () => {
    expect(graph.flatMap((node) => node.controllers)).toEqual([]);
  });

  it('declares broker consumers only in *WorkerModule', () => {
    const outside = graph
      .filter((node) => node.providers.some(isSubscriber) && !node.name.endsWith('WorkerModule'))
      .map((node) => node.name);

    expect(outside).toEqual([]);
  });

  it('registers the consumer of order events (the walk is not vacuous)', () => {
    const subscribers = graph.flatMap((node) =>
      node.providers.filter(isSubscriber).map((ctor) => ctor.name),
    );

    expect(subscribers).toEqual(['OrderEventsConsumer']);
  });

  it('runs the dispatcher and both cleanups, in a *WorkerModule', () => {
    const owners = graph
      .filter((node) => node.providers.some((ctor) => RUNNERS.includes(ctor.name)))
      .map((node) => node.name);

    expect(owners).toEqual(['NotificationsWorkerModule', 'InboxWorkerModule']);
  });
});
