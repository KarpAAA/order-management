import { Injectable } from '@nestjs/common';

import { runInUnitOfWork } from '@shared/events/unit-of-work';

interface UseCaseClass {
  prototype: { execute?: (...args: never[]) => Promise<unknown> };
}

/**
 * Marks an L3–4 use case: registers it as a provider and wraps `execute` in a unit of work,
 * so in-process events published inside `@Transactional()` fire only after the commit.
 * Step 4 adds the automatic log line, duration metric and trace span here.
 */
export function UseCase(): ClassDecorator {
  return (target) => {
    Injectable()(target);
    const prototype = (target as unknown as UseCaseClass).prototype;
    const execute = prototype.execute;
    if (!execute) throw new Error(`@UseCase() ${target.name} must declare execute()`);
    prototype.execute = function (this: unknown, ...args: never[]) {
      return runInUnitOfWork(() => execute.apply(this, args));
    };
  };
}
