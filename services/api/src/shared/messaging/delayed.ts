/**
 * The exchange of this service for a message that is to arrive later: what is published
 * there waits in a queue nobody reads and is handed to its reader when the wait is over
 * (infrastructure/messaging/delay-topology.ts). Not in `@oms/contracts`: no other service
 * publishes to it or reads from it.
 */
export const DELAYED_EXCHANGE = 'api.delayed';
