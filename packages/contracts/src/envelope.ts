import { z } from 'zod';

/**
 * What only the sender knows. The package generates no id and reads no clock: the sender
 * passes both, so a contract stays a pure function of its input.
 */
export interface MessageMeta {
  /** Unique per message: a consumer deduplicates on it. */
  messageId: string;
  occurredAt: Date;
  /** The tenant: a consumer binds its workspace from here, never from the payload. */
  workspaceId: string;
  /** The same for every message caused by one request. */
  correlationId: string;
}

/**
 * The part every message has, around its own `payload`.
 * Unknown keys are dropped, not rejected: a consumer built against an older contract keeps
 * reading a message that gained an optional field.
 */
const envelope = <N extends string, V extends number, P extends z.ZodType>(
  name: N,
  version: V,
  payload: P,
) =>
  z.object({
    messageId: z.uuid(),
    name: z.literal(name),
    version: z.literal(version),
    occurredAt: z.iso.datetime(),
    workspaceId: z.uuid(),
    correlationId: z.uuid(),
    payload,
  });

/**
 * One contract: a `name` that never changes and a `version` that changes with every
 * incompatible change (a removed or renamed field, a new type or meaning, a new required
 * field). An incompatible change is a new file `<name>.v<N+1>.ts` next to the old one, which
 * stays until no message of that version is left in a queue.
 */
export const defineMessage = <N extends string, V extends number, P extends z.ZodType>(
  name: N,
  version: V,
  payload: P,
) => {
  const schema = envelope(name, version, payload);
  return {
    name,
    version,
    schema,
    /** Builds the message and validates it: a sender cannot emit what a consumer would reject. */
    create: (meta: MessageMeta, body: z.input<P>) =>
      schema.parse({
        ...meta,
        occurredAt: meta.occurredAt.toISOString(),
        name,
        version,
        payload: body,
      }),
  };
};
