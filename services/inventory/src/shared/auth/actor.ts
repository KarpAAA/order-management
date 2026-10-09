/**
 * Who is doing this. The service has no users: every entry is a message from another
 * service, so the only actor is a system one, named after the entry that built it.
 */
export interface SystemActor {
  readonly kind: 'system';
  /** `<type>:<name>`, e.g. `consumer:inventory`. */
  readonly source: string;
}

export type Actor = SystemActor;

export const systemActor = (source: string): SystemActor => ({ kind: 'system', source });
