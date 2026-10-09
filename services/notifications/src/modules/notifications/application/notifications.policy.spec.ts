import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import { consumer, dispatcher, stranger } from './__test__/fixtures';
import { NotificationsPolicy } from './notifications.policy';

describe('NotificationsPolicy (NTF-022)', () => {
  const policy = new NotificationsPolicy();

  it('lets the consumer of the events ask for a notification, and nobody else', () => {
    expect(() => {
      policy.assertCanRequest(consumer);
    }).not.toThrow();
    for (const actor of [dispatcher, stranger]) {
      expect(() => {
        policy.assertCanRequest(actor);
      }).toThrow(ForbiddenError);
    }
  });

  it('lets the dispatcher send, and nobody else', () => {
    expect(() => {
      policy.assertCanDispatch(dispatcher);
    }).not.toThrow();
    for (const actor of [consumer, stranger]) {
      expect(() => {
        policy.assertCanDispatch(actor);
      }).toThrow(ForbiddenError);
    }
  });

  it('names the action it refused', () => {
    expect(() => {
      policy.assertCanRequest(stranger);
    }).toThrow('notifications.request');
    expect(() => {
      policy.assertCanDispatch(stranger);
    }).toThrow('notifications.dispatch');
  });
});
