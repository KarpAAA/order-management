import { GenericContainer, Wait } from 'testcontainers';

import type { StartedTestContainer } from 'testcontainers';

const SMTP_PORT = 1025;
const API_PORT = 8025;

/** The only domain the mail server of a run accepts: an address anywhere else is refused (550). */
export const ACCEPTED_DOMAIN = 'example.test';

/**
 * Throwaway mail server for one run: Mailpit takes every mail over SMTP and shows what it
 * took through its HTTP API. It refuses recipients outside `ACCEPTED_DOMAIN`, which is how a
 * test meets a server that says no.
 */
export function startMailpit(): Promise<StartedTestContainer> {
  return new GenericContainer('axllent/mailpit:v1.27')
    .withExposedPorts(SMTP_PORT, API_PORT)
    .withEnvironment({
      MP_SMTP_ALLOWED_RECIPIENTS: `@${ACCEPTED_DOMAIN.replace('.', '\\.')}$`,
      MP_DISABLE_VERSION_CHECK: 'true',
    })
    .withWaitStrategy(Wait.forHttp('/readyz', API_PORT))
    .start();
}

export const smtpHost = (container: StartedTestContainer): string => container.getHost();

export const smtpPort = (container: StartedTestContainer): number =>
  container.getMappedPort(SMTP_PORT);

export const mailpitUrl = (container: StartedTestContainer): string =>
  `http://${container.getHost()}:${String(container.getMappedPort(API_PORT))}`;
