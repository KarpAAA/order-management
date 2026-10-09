// The service against the contracts (docs/adr/0021-contract-testing.md), without a broker and
// without the api: its queue is bound to what the map of parties says it reads, it handles a
// message of each of those contracts as it was written on the day the version was released,
// and its adapter writes every contract the map says it writes, and no other.
import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { consumedBy, contractKey, exchanges, parseMessage, producedBy } from '@oms/contracts';
import { bindingProblems, releasedSample, type Binding } from '@oms/contracts/testing';
import { describe, expect, it, vi } from 'vitest';

import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import type { Clock } from '@shared/domain/clock';

import { OutboxPaymentEventsPublisher } from './infrastructure/outbox-payment-events.adapter';
import { PaymentsConsumer } from './payments.consumer';

import type { CancelPaymentService } from './cancel-payment.service';
import type { ChargePaymentService } from './charge-payment.service';
import type { PaymentResult } from './ports/payment-events-publisher.port';
import type { Party } from '@oms/contracts';

const SERVICE = 'payments';
const ATTEMPT = {
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  orderId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04',
  paymentAttempt: 2,
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};
const clock: Clock = { now: () => new Date('2026-10-06T10:15:30.123Z') };

const keyOf = (party: Party): string => contractKey(party.contract.name, party.contract.version);

/** What the `@RabbitSubscribe` methods of a consumer class ask of the broker. */
const bindingsOf = (consumer: { prototype: object }): Binding[] =>
  Object.values(Object.getOwnPropertyDescriptors(consumer.prototype)).flatMap((descriptor) => {
    const method: unknown = descriptor.value;
    if (typeof method !== 'function') return [];
    const binding = Reflect.getMetadata(RABBIT_HANDLER, method) as Binding | undefined;
    return binding ? [binding] : [];
  });

describe('payments as a consumer', () => {
  const READ = consumedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-020 binds its queue to the contracts the map gives it, and to nothing else', () => {
    const bindings = bindingsOf(PaymentsConsumer);

    expect(bindings).toHaveLength(1);
    expect(bindingProblems(SERVICE, bindings)).toEqual([]);
  });

  it.each(READ)('CTR-021 handles $key as it was released', async ({ contract }) => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const consumer = new PaymentsConsumer(
      { execute } as unknown as ChargePaymentService,
      { execute } as unknown as CancelPaymentService,
    );
    const delivery = { attempt: 1, last: false };

    await expect(consumer.onCommand(releasedSample(contract), delivery)).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('payments as a producer', () => {
  /** How the service comes to write each contract: the outcome its adapter is given. */
  const EMITTERS: Record<string, PaymentResult> = {
    'payments.payment-succeeded@1': { status: 'succeeded', chargeId: 'ch_1' },
    'payments.payment-failed@1': {
      status: 'failed',
      failureCode: 'psp_unavailable',
      chargeId: null,
    },
    'payments.payment-cancelled@1': { status: 'cancelled' },
  };

  async function written(result: PaymentResult): Promise<OutboxEntry> {
    const { outbox, appended } = recordingOutbox();
    await new OutboxPaymentEventsPublisher(outbox, clock).publish({ ...ATTEMPT, result });
    expect(appended).toHaveLength(1);
    return appended[0]!;
  }

  const WRITTEN = producedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-030 writes the contracts the map gives it, and no other', () => {
    expect(Object.keys(EMITTERS).sort()).toEqual(WRITTEN.map(({ key }) => key).sort());
  });

  it.each(WRITTEN)('CTR-030 writes $key as its readers accept it', async ({ key, exchange }) => {
    const entry = await written(EMITTERS[key]!);

    const read = parseMessage(JSON.parse(JSON.stringify(entry.message)));
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && contractKey(read.message.name, read.message.version)).toBe(key);
    expect(entry.exchange).toBe(exchanges[exchange].name);
  });
});
