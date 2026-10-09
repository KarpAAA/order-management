import { describe, expect, it } from 'vitest';

import { ALL_NOTICES, NOTICES, ORDER } from './__test__/builders';
import { formatMoment, formatMoney, render } from './templates';

describe('formatMoney', () => {
  it.each([
    [{ amountMinor: 12_990, currency: 'EUR' }, '129.90 EUR'],
    [{ amountMinor: 5, currency: 'USD' }, '0.05 USD'],
    [{ amountMinor: 0, currency: 'EUR' }, '0.00 EUR'],
    // a currency with no minor unit, and one with three digits of it
    [{ amountMinor: 1500, currency: 'JPY' }, '1500 JPY'],
    [{ amountMinor: 1500, currency: 'KWD' }, '1.500 KWD'],
  ])('%o reads %s', (money, expected) => {
    expect(formatMoney(money)).toBe(expected);
  });
});

describe('formatMoment', () => {
  it('reads the same for every reader: UTC, to the minute', () => {
    expect(formatMoment(new Date('2026-10-09T14:02:59.999Z'))).toBe('2026-10-09 14:02 UTC');
  });
});

describe('render', () => {
  it.each(ALL_NOTICES)('NTF-002 $kind names the order and when the fact happened', (notice) => {
    const { subject, body } = render(notice);

    expect(subject).not.toBe('');
    expect(body).toContain(`Order ${ORDER}`);
    expect(body).toContain('2026-01-15 09:58 UTC');
  });

  it('NTF-002 every kind has a subject of its own', () => {
    const subjects = ALL_NOTICES.map((notice) => render(notice).subject);

    expect(new Set(subjects).size).toBe(ALL_NOTICES.length);
  });

  it.each([NOTICES.placed, NOTICES.paid, NOTICES.paymentFailed])(
    'NTF-001 $kind says the amount of its own event',
    (notice) => {
      expect(render(notice).body).toContain('129.90 EUR');
    },
  );

  it('NTF-001 placed: received, and not charged yet', () => {
    const { subject, body } = render(NOTICES.placed);

    expect(subject).toBe('We received your order');
    expect(body).toContain('will be charged once its items are reserved');
  });

  it.each([
    ['out_of_stock', 'some of its items are out of stock'],
    ['inventory_unavailable', 'we could not confirm that its items are in stock'],
  ])('NTF-001 returned to draft because of %s: says so in words', (reason, words) => {
    const { body } = render({ ...NOTICES.returnedToDraft, reason });

    expect(body).toContain(words);
    expect(body).toContain('Nothing was charged');
  });

  it.each(['payment_timeout', 'psp_unavailable', 'expired'])(
    'NTF-001 payment failed with %s: the provider did not answer',
    (reason) => {
      const { body } = render({ ...NOTICES.paymentFailed, reason });

      expect(body).toContain('the payment provider did not answer in time');
      expect(body).not.toContain(reason);
    },
  );

  it('NTF-001 payment failed with a decline code: declined, with the code', () => {
    expect(render(NOTICES.paymentFailed).body).toContain(
      'the payment was declined (card_declined)',
    );
  });
});
