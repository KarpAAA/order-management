import type { NoticeMoney, OrderNotice } from './order-notice';

export interface Mail {
  subject: string;
  body: string;
}

/** `12990 EUR` → `129.90 EUR`: the digits after the point are the currency's own (JPY has none). */
export function formatMoney({ amountMinor, currency }: NoticeMoney): string {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return `${(amountMinor / 10 ** digits).toFixed(digits)} ${currency}`;
}

/** `2026-10-09 14:02 UTC`: the same for every reader, whatever the server's zone. */
export function formatMoment(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What the user reads for a reason the services exchange as a code. */
function describeReason(reason: string): string {
  switch (reason) {
    case 'out_of_stock':
      return 'some of its items are out of stock';
    case 'inventory_unavailable':
      return 'we could not confirm that its items are in stock';
    case 'payment_timeout':
    case 'psp_unavailable':
    case 'expired':
      return 'the payment provider did not answer in time';
    default:
      return `the payment was declined (${reason})`;
  }
}

function text(notice: OrderNotice): Mail {
  const at = formatMoment(notice.occurredAt);
  switch (notice.kind) {
    case 'order-placed':
      return {
        subject: 'We received your order',
        body: `We received your order on ${at}. ${formatMoney(notice.amount)} will be charged once its items are reserved.`,
      };
    case 'order-paid':
      return {
        subject: 'Your order is paid',
        body: `Your payment of ${formatMoney(notice.amount)} went through on ${at}.`,
      };
    case 'order-cancelled':
      return {
        subject: 'Your order was cancelled',
        body: `Your order was cancelled on ${at}. Nothing will be charged for it.`,
      };
    case 'order-fulfilled':
      return {
        subject: 'Your order was fulfilled',
        body: `Your order was handed over on ${at}.`,
      };
    case 'order-payment-failed':
      return {
        subject: 'The payment for your order did not go through',
        body: `On ${at} we could not charge ${formatMoney(notice.amount)} for your order: ${describeReason(notice.reason)}. Nothing was charged; you can place the order again.`,
      };
    case 'order-returned-to-draft':
      return {
        subject: 'Your order could not be placed',
        body: `On ${at} your order went back to a draft: ${describeReason(notice.reason)}. Nothing was charged; you can change the order and place it again.`,
      };
  }
}

/**
 * The mail of a notice: a pure function of that one notice. It names the order and says when
 * the fact happened, so a mail that arrives after a later one still reads true.
 */
export function render(notice: OrderNotice): Mail {
  const { subject, body } = text(notice);
  return { subject, body: `${body}\n\nOrder ${notice.orderId}\n` };
}
