// Where an app of the test suite writes its log: a list in memory instead of stdout, put in
// the place of LOG_DESTINATION. A run stays quiet (the suite provokes hundreds of refusals on
// purpose), and a test about the log reads the lines the app wrote.
import type { DestinationStream } from 'pino';

/** One line as the app wrote it: the JSON of pino, parsed. */
export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  time: string;
  service: string;
  process?: string;
  context?: string;
  correlationId?: string;
  msg: string;
  [field: string]: unknown;
}

export interface LogCapture {
  destination: DestinationStream;
  lines(): LogLine[];
}

export function captureLogs(): LogCapture {
  const lines: LogLine[] = [];
  return {
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
    lines: () => [...lines],
  };
}
