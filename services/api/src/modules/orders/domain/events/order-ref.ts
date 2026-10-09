/**
 * Which order an event is about and who created it: what every event of an order carries.
 * The creator is whom a message about the order is for (infrastructure/order-events.translator.ts).
 */
export interface OrderRef {
  workspaceId: string;
  orderId: string;
  createdBy: string;
}
