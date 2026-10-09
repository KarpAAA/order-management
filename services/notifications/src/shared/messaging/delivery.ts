/**
 * Which delivery of a broker message a consumer is handling, counted from the broker's record
 * of its rejections. The second argument of a `@RabbitSubscribe` method.
 */
export interface Delivery {
  attempt: number;
  /** No delivery follows this one: whatever fails now is given up. */
  last: boolean;
}
