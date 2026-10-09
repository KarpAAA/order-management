export const INBOX = Symbol('INBOX');

/**
 * What a broker consumer knows about the messages it has handled. A message is delivered at
 * least once; with this it takes effect once per consumer.
 */
export interface Inbox {
  /**
   * Runs `handle` in one transaction with the record of the message, unless this consumer
   * has handled the message before. False: a duplicate, `handle` did not run.
   * Whatever `handle` throws is thrown on, and the message stays unhandled: the next
   * delivery runs it again.
   */
  once(consumer: string, messageId: string, handle: () => Promise<void>): Promise<boolean>;
}
