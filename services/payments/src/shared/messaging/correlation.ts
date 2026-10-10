/**
 * The correlation id of the message under way: the same for every message and every log
 * line one piece of work causes, across the services (docs/adr/0023). The subscribers of
 * the broker open the chain of a delivery; whatever handles it reads the id here, never
 * from a parameter.
 */
export interface Correlation {
  /** The id of the chain, or `undefined` for work that belongs to none (a timer). */
  current(): string | undefined;
  /** Inside a scope: what follows belongs to the chain `correlationId`. */
  continue(correlationId: string): void;
  /**
   * Runs `work` as a part of the chain `correlationId`, in a scope of its own. The scope
   * inherits what the caller's holds, a transaction included.
   */
  run<T>(correlationId: string, work: () => T): T;
}

export const CORRELATION = Symbol('CORRELATION');
