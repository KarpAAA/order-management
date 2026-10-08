/**
 * The only source of "now" for business decisions. Use cases inject it and pass `now`
 * into the domain; tests (Step 1) replace it with a fixed clock.
 * Abstract class rather than an interface so it doubles as the DI token.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
