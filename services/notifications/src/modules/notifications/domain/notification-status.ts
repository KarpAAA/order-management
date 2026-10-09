/** Mirrors the Prisma enum `NotificationStatus` one-to-one. */
export enum NotificationStatus {
  /** Owed: not sent yet, or a try failed and the next one is due. */
  Pending = 'PENDING',
  /** The mail server took it. */
  Sent = 'SENT',
  /** Given up: the server refused it for good, or every try failed. */
  Failed = 'FAILED',
}
