// The commands of the service as the api would send them, and the stock they act on.
import { AdjustStockV1, ReleaseStockV1, ReserveStockV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';

import { testDb } from '../setup/db';

import type { MessageMeta } from '@oms/contracts';

export const WORKSPACE = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02';
export const OTHER_WORKSPACE = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e99';

// the queues the service declares for itself: names on the wire, so the tests spell them out
export const COMMANDS_QUEUE = 'inventory.commands';
export const DEAD_LETTER_QUEUE = 'inventory.commands.dlq';

/** What a test may fix about the envelope; the rest is new for every message. */
type Envelope = Partial<Pick<MessageMeta, 'messageId' | 'workspaceId' | 'correlationId'>>;

const meta = (envelope: Envelope): MessageMeta => ({
  messageId: uuidv7(),
  occurredAt: new Date(),
  workspaceId: WORKSPACE,
  correlationId: uuidv7(),
  ...envelope,
});

interface Attempt extends Envelope {
  orderId: string;
  attempt?: number;
}

export const reserveCommand = ({
  orderId,
  attempt = 1,
  lines,
  ...envelope
}: Attempt & { lines: { productId: string; quantity: number }[] }): ReserveStockV1 =>
  ReserveStockV1.create(meta(envelope), { orderId, attempt, lines });

export const releaseCommand = ({ orderId, attempt = 1, ...envelope }: Attempt): ReleaseStockV1 =>
  ReleaseStockV1.create(meta(envelope), { orderId, attempt });

export const adjustCommand = ({
  productId,
  delta,
  ...envelope
}: Envelope & { productId: string; delta: number }): AdjustStockV1 =>
  AdjustStockV1.create(meta(envelope), { productId, delta });

/** Stock written as the owner of the database, past the service: the state a test starts from. */
export async function givenStock(onHand: number, workspaceId = WORKSPACE): Promise<string> {
  const productId = uuidv7();
  const now = new Date();
  await testDb().stockItem.create({
    data: { workspaceId, productId, onHand, createdAt: now, updatedAt: now },
  });
  return productId;
}

export const levelsOf = (productId: string) =>
  testDb().stockItem.findFirst({
    where: { productId },
    select: { onHand: true, reserved: true },
  });

export const reservationsOf = (orderId: string) =>
  testDb().reservation.findMany({
    where: { orderId },
    orderBy: { attempt: 'asc' },
    select: {
      attempt: true,
      status: true,
      version: true,
      lines: { select: { productId: true, quantity: true, available: true } },
    },
  });
