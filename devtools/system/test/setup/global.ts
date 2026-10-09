// Once per run: the compose project `oms-system` (docker-compose.system.yml), from nothing.
// Volumes are removed first: the scenarios spend the seeded stock and expect an empty mailbox
// of their orders, so a run never starts from the last one's state.
//   SYSTEM_KEEP_STACK=1   leave the stack up afterwards, to look at it (pnpm system:down)
// The logs of every container are saved before the stack goes: with four services between a
// request and its outcome, a failed scenario cannot be explained without them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eventually } from '../helpers/eventually';

import { stack } from './stack';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPORTS = fileURLToPath(new URL('../../reports/', import.meta.url));

const COMPOSE = [
  'compose',
  ...['-p', 'oms-system'],
  ...['-f', 'docker-compose.yml', '-f', 'docker-compose.system.yml'],
  ...['--profile', 'app'],
];

/**
 * A queue per consumer of the system. An event needs no subscriber (docs/adr/0014): one
 * published before notifications has bound its queue is a mail nobody writes. The services
 * have no health endpoint yet (Step 4), so the broker is asked who listens.
 */
const CONSUMED_QUEUES = [
  'api.inventory-events',
  'api.payment-events',
  'api.saga-timeouts',
  'inventory.commands',
  'payments.commands',
  'notifications.order-events',
];

const say = (message: string): void => {
  process.stdout.write(`[system] ${message}\n`);
};

const seconds = (since: number): string => `${((Date.now() - since) / 1000).toFixed(1)} s`;

/** Runs a compose command of the project, its output shown as it comes. */
function compose(args: string[]): void {
  execFileSync('docker', [...COMPOSE, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
}

/** Runs one and gives back what it printed. */
function composeOutput(args: string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function saveLogs(): void {
  mkdirSync(REPORTS, { recursive: true });
  const file = `${REPORTS}stack.log`;
  writeFileSync(file, composeOutput(['logs', '--no-color', '--timestamps']));
  say(`logs of the stack: ${file}`);
}

const answers = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

/** The queues that have a consumer, as the broker lists them. */
function listenedQueues(): string[] {
  const rows = composeOutput([
    ...['exec', '-T', 'rabbitmq'],
    ...['rabbitmqctl', '-q', 'list_queues', 'name', 'consumers'],
  ]);
  return rows
    .split('\n')
    .map((row) => row.trim().split(/\s+/))
    .filter(([, consumers]) => Number(consumers) > 0)
    .map(([name]) => name ?? '');
}

async function ready(): Promise<void> {
  const wait = { timeoutMs: 120_000, intervalMs: 500 };
  // the api has no healthcheck: its OpenAPI document is served once it listens
  await eventually(() => answers(`${stack.api}/docs-json`), Boolean, { ...wait, what: 'the api' });
  await eventually(() => answers(`${stack.psp}/admin/stats`), Boolean, {
    ...wait,
    what: 'the provider',
  });
  await eventually(() => answers(`${stack.mailpit}/readyz`), Boolean, { ...wait, what: 'Mailpit' });
  await eventually(
    () => Promise.resolve(listenedQueues()),
    (listened) => CONSUMED_QUEUES.every((queue) => listened.includes(queue)),
    { ...wait, what: `a consumer on each of ${CONSUMED_QUEUES.join(', ')}` },
  );
}

export default async function setup(): Promise<() => void> {
  const started = Date.now();
  compose(['down', '--volumes', '--remove-orphans']);
  try {
    compose(['up', '--detach', '--build', '--wait']);
    say(`containers up after ${seconds(started)}`);
    await ready();
  } catch (err: unknown) {
    saveLogs();
    throw err;
  }
  say(`stack ready after ${seconds(started)}`);

  return () => {
    saveLogs();
    if (process.env.SYSTEM_KEEP_STACK === '1') {
      say('stack left up (SYSTEM_KEEP_STACK=1); remove it with `pnpm system:down`');
      return;
    }
    compose(['down', '--volumes', '--remove-orphans']);
  };
}
