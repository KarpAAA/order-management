import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, NOW, PRODUCT_A, stockItem, WORKSPACE_ID } from '../domain/__test__/builders';
import { StockBelowReservedError, StockItemAlreadyExistsError } from '../domain/errors';

import {
  consumer,
  CORRELATION_ID,
  enableNoOpTransactions,
  fixedClock,
  stranger,
} from './__test__/fixtures';
import { InMemoryStockRepository } from './__test__/in-memory-stock.repository';
import { RecordingEventsPublisher } from './__test__/recording-events-publisher';
import { AdjustStockService } from './adjust-stock.service';
import { InventoryPolicy } from './inventory.policy';

import type { Journal } from './__test__/fixtures';
import type { AdjustStockCommand } from './inventory-commands';

const command = (delta: number): AdjustStockCommand => ({
  workspaceId: WORKSPACE_ID,
  productId: PRODUCT_A,
  delta,
  correlationId: CORRELATION_ID,
});

describe('AdjustStockService', () => {
  let journal: Journal;
  let stock: InMemoryStockRepository;
  let publisher: RecordingEventsPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    journal = [];
    stock = new InMemoryStockRepository(journal);
    publisher = new RecordingEventsPublisher(journal);
  });

  const adjustStock = (): AdjustStockService =>
    new AdjustStockService(stock, new InventoryPolicy(), fixedClock, publisher);

  it('adds what arrived to what is there and answers with the levels', async () => {
    stock.put(stockItem({ onHand: 10, reserved: 4 }));

    await adjustStock().execute(command(50), consumer);

    expect(stock.get(PRODUCT_A)?.snapshot()).toMatchObject({
      onHand: 60,
      reserved: 4,
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect(publisher.answers).toEqual([
      { answer: 'adjusted', productId: PRODUCT_A, onHand: 60, reserved: 4 },
    ]);
    expect(publisher.correlationIds).toEqual([CORRELATION_ID]);
    expect(journal).toEqual([`lock stock ${PRODUCT_A}`, 'save stock', 'answer']);
  });

  it('opens the stock of a product it hears of for the first time', async () => {
    await adjustStock().execute(command(7), consumer);

    expect(stock.get(PRODUCT_A)?.snapshot()).toEqual({
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_A,
      onHand: 7,
      reserved: 0,
      createdAt: LATER,
      updatedAt: LATER,
    });
    expect(journal).toEqual([`lock stock ${PRODUCT_A}`, 'insert stock', 'answer']);
  });

  it('takes away what left', async () => {
    stock.put(stockItem({ onHand: 10, reserved: 4 }));

    await adjustStock().execute(command(-6), consumer);

    expect(publisher.answers).toEqual([
      { answer: 'adjusted', productId: PRODUCT_A, onHand: 4, reserved: 4 },
    ]);
  });

  it('refuses to take away what reservations hold, and answers nothing', async () => {
    stock.put(stockItem({ onHand: 10, reserved: 4 }));

    await expect(adjustStock().execute(command(-7), consumer)).rejects.toThrow(
      StockBelowReservedError,
    );
    expect(stock.get(PRODUCT_A)?.onHand).toBe(10);
    expect(publisher.answers).toEqual([]);
  });

  it('refuses to take away from a product it has never heard of', async () => {
    await expect(adjustStock().execute(command(-1), consumer)).rejects.toThrow(
      StockBelowReservedError,
    );
    expect(stock.get(PRODUCT_A)).toBeUndefined();
  });

  it('leaves the refusal of a second opener of the same product to the caller', async () => {
    // another delivery opens the product after this one found no stock to lock
    const lockMany = stock.lockMany.bind(stock);
    stock.lockMany = async (workspaceId, productIds) => {
      const locked = await lockMany(workspaceId, productIds);
      stock.put(stockItem({ onHand: 3 }));
      return locked;
    };

    await expect(adjustStock().execute(command(7), consumer)).rejects.toThrow(
      StockItemAlreadyExistsError,
    );
    expect(stock.get(PRODUCT_A)?.onHand).toBe(3);
    expect(publisher.answers).toEqual([]);
  });

  it('is for the consumer of the service only, and touches nothing before it knows', async () => {
    await expect(adjustStock().execute(command(1), stranger)).rejects.toThrow(ForbiddenError);
    expect(journal).toEqual([]);
  });
});
