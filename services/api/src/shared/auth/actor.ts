/**
 * Who is doing this. Roles are per workspace (`role-scope: contextual`), so the actor never
 * carries them: the membership for the current workspace is resolved per request and passed
 * to policies as a separate parameter (auth/actor.md §4).
 */
export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
}

export interface SystemActor {
  readonly kind: 'system';
  /** `<type>:<name>`, e.g. `consumer:orders`. */
  readonly source: string;
}

export type Actor = UserActor | SystemActor;

export const userActor = (userId: string): UserActor => ({ kind: 'user', userId });
export const systemActor = (source: string): SystemActor => ({ kind: 'system', source });
export const isUser = (actor: Actor): actor is UserActor => actor.kind === 'user';

/** Stable string for audit columns: the user id, or `system:<source>`. */
export const actorRef = (actor: Actor): string =>
  actor.kind === 'user' ? actor.userId : `system:${actor.source}`;
