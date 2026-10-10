import { Inject, Injectable, Optional } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { METRICS, type Counter, type Metrics } from '@shared/observability/metrics';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { OutboxRelay } from './outbox-relay';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

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
  private readonly log: Logger;
  private running: Promise<void> | undefined;
  private stopped = false;
  private stuck = false;
  private wake: (() => void) | undefined;
  private readonly published: Counter<never>;

  constructor(
    private readonly relay: OutboxRelay,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
    @Inject(LOGGER) logger: Logger,
    @Optional() @Inject(METRICS) metrics: Metrics = silentMetrics,
  ) {
    this.log = logger.child({ context: OutboxRelayRunner.name });
    this.published = metrics.counter({
      name: 'outbox_published_total',
      help: 'Messages the relay handed to the broker.',
    });
  }

  onApplicationBootstrap(): void {
    if (!this.config.relayEnabled) {
      this.log.warn({}, 'outbox relay is off: OUTBOX_RELAY_ENABLED=false');
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
      if (pass.published > 0) this.published.inc({}, pass.published);
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
    this.log.error({ err: error }, 'outbox relay stuck, messages wait in the table');
  }

  private recovered(): void {
    if (!this.stuck) return;
    this.stuck = false;
    this.log.info({}, 'outbox relay publishes again');
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
