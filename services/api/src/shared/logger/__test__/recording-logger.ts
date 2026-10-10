import type { Logger } from '../logger';

export interface RecordedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** The fields of the line and the bindings of the child that wrote it. */
  fields: Record<string, unknown>;
}

/**
 * A logger that keeps what it is given, for a test: `lines` is shared by every child, so a
 * test hands `new RecordingLogger()` to a class and reads what that class logged.
 */
export class RecordingLogger implements Logger {
  constructor(
    readonly lines: RecordedLine[] = [],
    private readonly bindings: object = {},
  ) {}

  debug(fields: object, message: string): void {
    this.record('debug', fields, message);
  }

  info(fields: object, message: string): void {
    this.record('info', fields, message);
  }

  warn(fields: object, message: string): void {
    this.record('warn', fields, message);
  }

  error(fields: object, message: string): void {
    this.record('error', fields, message);
  }

  child(bindings: object): Logger {
    return new RecordingLogger(this.lines, { ...this.bindings, ...bindings });
  }

  /** The lines of one level, oldest first. */
  at(level: RecordedLine['level']): RecordedLine[] {
    return this.lines.filter((line) => line.level === level);
  }

  private record(level: RecordedLine['level'], fields: object, message: string): void {
    this.lines.push({ level, message, fields: { ...this.bindings, ...fields } });
  }
}
