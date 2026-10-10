import { Inject, Injectable } from '@nestjs/common';

import { failSpan, inSpan } from '@common/tracing/trace-context';
import { actorRef, type Actor } from '@shared/auth/actor';
import { DomainError } from '@shared/errors/domain-error';
import { runInUnitOfWork } from '@shared/events/unit-of-work';
import { LOGGER, type Logger } from '@shared/logger/logger';

interface UseCaseClass {
  prototype: { execute?: (...args: never[]) => Promise<unknown> };
}

/**
 * Where the injector puts the logger of the process on a use case. A decorator runs when its
 * class is loaded and takes no constructor parameter of its own, so the logger is injected as
 * a property. A use case a unit test builds by hand has none, and logs nothing.
 */
const LOG = Symbol('useCase.log');

interface Logged {
  [LOG]?: Logger;
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
 * And it is the span of the use case in a trace (ops/observability.md §3): its name, the
 * kind of its actor and the same outcome. A refusal of the business is an outcome, not an
 * error of the span: only what is not a `DomainError` shows red.
 */
export function UseCase(): ClassDecorator {
  return (target) => {
    Injectable()(target);
    Inject(LOGGER)(target.prototype as object, LOG);
    const prototype = (target as unknown as UseCaseClass).prototype;
    const execute = prototype.execute;
    if (!execute) throw new Error(`@UseCase() ${target.name} must declare execute()`);
    prototype.execute = function (this: Logged, ...args: never[]) {
      return inSpan(target.name, (span) => {
        const actor = (args as readonly unknown[]).find(isActor);
        if (actor) span.setAttribute('actor.kind', actor.kind);
        return logged.call(this, args).then(
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
    const logged = async function (this: Logged, args: never[]) {
      const log = this[LOG];
      const startedAt = performance.now();
      const line = (outcome: string) => ({
        context: 'UseCase',
        useCase: target.name,
        ...actorOf(args),
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
      });
      try {
        const result = await runInUnitOfWork(() => execute.apply(this, args));
        log?.info(line('ok'), 'use case');
        return result;
      } catch (err: unknown) {
        log?.warn(line(err instanceof DomainError ? err.code : 'error'), 'use case');
        throw err;
      }
    };
  };
}

/** The actor is a parameter of every use case (principles #2): the one that looks like one. */
function actorOf(args: readonly unknown[]): { actor?: string } {
  const actor = args.find(isActor);
  return actor === undefined ? {} : { actor: actorRef(actor) };
}

function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  return value.kind === 'user' || value.kind === 'system';
}
