import { Inject, Injectable, Optional } from '@nestjs/common';

import { failSpan, inSpan } from '@common/tracing/trace-context';
import { actorRef, type Actor } from '@shared/auth/actor';
import { DomainError } from '@shared/errors/domain-error';
import { runInUnitOfWork } from '@shared/events/unit-of-work';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { METRICS, secondsSince, type Metrics } from '@shared/observability/metrics';

interface UseCaseClass {
  prototype: { execute?: (...args: never[]) => Promise<unknown> };
}

/**
 * Where the injector puts the logger of the process on a use case. A decorator runs when its
 * class is loaded and takes no constructor parameter of its own, so the logger is injected as
 * a property. A use case a unit test builds by hand has none, and logs nothing.
 */
const LOG = Symbol('useCase.log');
/** The metrics of the process, put on a use case the same way. */
const METER = Symbol('useCase.metrics');

interface Logged {
  [LOG]?: Logger;
  [METER]?: Metrics;
}

/**
 * Marks an L3–4 use case: registers it as a provider and wraps `execute` in a unit of work,
 * so in-process events published inside `@Transactional()` fire only after the commit.
 *
 * It also writes the line of the use case (ops/logging.md §3): which one, for whom, how long,
 * and how it ended: `ok`, the code of the `DomainError` business answered with, or `error`.
 * The error itself is logged once, by the entry that receives it (the exception filter, the
 * error handler of the broker): not here.
 *
 * It observes `use_case_duration_seconds` with the same name and outcome
 * (ops/observability.md §1): a use case never counts its own time.
 *
 * And it is the span of the use case in a trace (ops/observability.md §3): its name, the
 * kind of its actor and the same outcome. A refusal of the business is an outcome, not an
 * error of the span: only what is not a `DomainError` shows red.
 */
export function UseCase(): ClassDecorator {
  return (target) => {
    Injectable()(target);
    Inject(LOGGER)(target.prototype as object, LOG);
    Inject(METRICS)(target.prototype as object, METER);
    // a testing module of one use case provides the logger and no metrics
    Optional()(target.prototype as object, METER);
    const prototype = (target as unknown as UseCaseClass).prototype;
    const execute = prototype.execute;
    if (!execute) throw new Error(`@UseCase() ${target.name} must declare execute()`);
    prototype.execute = function (this: Logged, ...args: never[]) {
      return inSpan(target.name, (span) => {
        const actor = (args as readonly unknown[]).find(isActor);
        if (actor) span.setAttribute('actor.kind', actor.kind);
        return logged.call(this, target.name, execute, args).then(
          (result) => {
            span.setAttribute('outcome', 'ok');
            return result;
          },
          (err: unknown) => {
            span.setAttribute('outcome', err instanceof DomainError ? err.code : 'error');
            if (!(err instanceof DomainError)) failSpan(span, err);
            throw err;
          },
        );
      });
    };
  };
}

/**
 * One run of `execute` in its unit of work, with its line and its observation: the same
 * outcome in both.
 */
async function logged(
  this: Logged,
  useCase: string,
  execute: (...args: never[]) => Promise<unknown>,
  args: never[],
): Promise<unknown> {
  const log = this[LOG];
  const startedAt = performance.now();
  const ended = (outcome: string) => {
    // the codes of the `DomainError`s are a closed set: a label may carry them
    this[METER]?.histogram(DURATION).observe(
      { use_case: useCase, outcome },
      secondsSince(startedAt),
    );
    return {
      context: 'UseCase',
      useCase,
      ...actorOf(args),
      durationMs: Math.round(performance.now() - startedAt),
      outcome,
    };
  };
  try {
    const result = await runInUnitOfWork(() => execute.apply(this, args));
    log?.info(ended('ok'), 'use case');
    return result;
  } catch (err: unknown) {
    log?.warn(ended(err instanceof DomainError ? err.code : 'error'), 'use case');
    throw err;
  }
}

const DURATION = {
  name: 'use_case_duration_seconds',
  help: 'Time a use case took, by how it ended.',
  labels: ['use_case', 'outcome'],
} as const;

/** The actor is a parameter of every use case (principles #2): the one that looks like one. */
function actorOf(args: readonly unknown[]): { actor?: string } {
  const actor = args.find(isActor);
  return actor === undefined ? {} : { actor: actorRef(actor) };
}

function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  return value.kind === 'user' || value.kind === 'system';
}
