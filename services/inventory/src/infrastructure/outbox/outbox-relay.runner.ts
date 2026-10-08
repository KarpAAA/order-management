import { Inject, Injectable, Logger } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';

import { OutboxRelay } from './outbox-relay';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Keeps the relay going for as long as the process lives: pass after pass while there is a
 * full batch, a pause after a pass that found less. Starts on its own, so it is provided by
 * the worker module only (principles #12).
 *
 * A relay that cannot publish is logged once as an error (somebody must look: the broker is
 * down, or a command has no queue), then quietly retried every interval, and logged again
 * when it recovers. Nothing is lost meanwhile: the messages wait in the table.
 */
@Injectable()
export class OutboxRelayRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private running: Promise<void> | undefined;
  private stopped = false;
  private stuck = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly relay: OutboxRelay,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.relayEnabled) {
      this.logger.warn('outbox relay is off: OUTBOX_RELAY_ENABLED=false');
      return;
    }
    this.running = this.run();
  }

  /** Waits for the pass under way: its transaction ends before the database client closes. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const more = await this.once();
      if (!more) await this.pause();
    }
  }

  private async once(): Promise<boolean> {
    try {
      const pass = await this.relay.pass();
      if (pass.failure !== undefined) this.report(pass.failure);
      else if (!pass.skipped) this.recovered();
      return pass.more;
    } catch (err: unknown) {
      this.report(err);
      return false;
    }
  }

  private report(error: unknown): void {
    if (this.stuck) return;
    this.stuck = true;
    this.logger.error(`outbox relay stuck, messages wait in the table: ${describe(error)}`);
  }

  private recovered(): void {
    if (!this.stuck) return;
    this.stuck = false;
    this.logger.log('outbox relay publishes again');
  }

  /** Until the next pass is due, or until the process stops. */
  private pause(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.config.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
