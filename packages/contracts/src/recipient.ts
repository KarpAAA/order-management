import { z } from 'zod';

/**
 * Whom a message about an order is for: the user who created it. The publisher puts the
 * address in the event, so a subscriber that writes to that user needs nothing but the
 * event, and no other event before it.
 */
export const recipient = z.object({
  userId: z.uuid(),
  email: z.email(),
});

export type Recipient = z.infer<typeof recipient>;
