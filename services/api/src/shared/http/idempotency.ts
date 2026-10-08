export const IDEMPOTENCY = Symbol('IDEMPOTENCY');

/** One attempt of a client to do something, as the server tells it from any other. */
export interface IdempotentRequest {
  /** Whose key it is: a key means nothing outside its user. */
  userId: string;
  /** What was asked for: the method and the path, so one key cannot answer two routes. */
  scope: string;
  /** Chosen by the client, the same on every retry of this attempt. */
  key: string;
  /** A digest of the body: the same key with another body is another request, and refused. */
  fingerprint: string;
}

/** What the first request with a key was answered with. */
export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome {
  response: StoredResponse;
  /** True: `handle` did not run, the response is the one stored for the key. */
  replayed: boolean;
}

/**
 * What the server remembers of the writes it has answered: a request that comes again with
 * the key of an earlier one gets the earlier answer, and its work is not done twice
 * (http/api-conventions.md §5).
 */
export interface Idempotency {
  /**
   * Runs `handle` in one transaction with the record of the key, unless the key is known.
   * Throws `IdempotencyKeyReusedError` for a known key with another body, and
   * `IdempotencyKeyInProgressError` when a request with the key is being handled right now.
   * Whatever `handle` throws is thrown on and nothing is recorded: the key is free again.
   */
  once(
    request: IdempotentRequest,
    handle: () => Promise<StoredResponse>,
  ): Promise<IdempotentOutcome>;
}
