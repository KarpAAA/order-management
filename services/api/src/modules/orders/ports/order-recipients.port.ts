export const ORDER_RECIPIENTS = Symbol('ORDER_RECIPIENTS');

/** Whom a message about an order is for, and where it reaches them. */
export interface OrderRecipient {
  userId: string;
  email: string;
}

/**
 * "Where do I write to the user behind this id?" An order keeps the id of who created it;
 * the address belongs to identity. Asked by the translation of an order event, inside the
 * transaction of the use case: a read, never a call to the outside.
 */
export interface OrderRecipients {
  /** Throws when identity does not know the user: an event without a recipient is not written. */
  of(userId: string): Promise<OrderRecipient>;
}
