import { newId } from '@shared/domain/id';

import { correlationIdFrom } from '../correlation/correlation-id';

import type { ConsumeMessage } from 'amqplib';

/** The `correlationId` of an envelope, when the body is one. */
function ofEnvelope(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('correlationId' in body)) return undefined;
  return correlationIdFrom(body.correlationId);
}

/** The body of a delivery as it came, for the handler of a failure, which gets no parsed one. */
function bodyOf(message: ConsumeMessage | undefined): unknown {
  try {
    return message === undefined ? undefined : JSON.parse(message.content.toString());
  } catch {
    return undefined;
  }
}

/**
 * The correlation id a delivery is handled under, known before the body is checked against
 * its contract: the AMQP property its publisher set (the relay of an outbox copies it from
 * the envelope), or the one of the envelope when the property is not there (a message
 * published by hand). A message that names no chain begins one.
 */
export function correlationOf(message: ConsumeMessage | undefined, body?: unknown): string {
  return (
    correlationIdFrom(message?.properties.correlationId) ??
    ofEnvelope(body ?? bodyOf(message)) ??
    newId()
  );
}
