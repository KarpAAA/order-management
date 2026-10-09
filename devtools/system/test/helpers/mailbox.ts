// What the mail server of the stack took, read through Mailpit's HTTP API (the same reading
// as services/notifications/test/helpers/mailbox.ts). Every scenario writes to the same seeded
// user, so a mail is found by the order it names: the last line of every mail is `Order <id>`.
import { stack } from '../setup/stack';

import { eventually } from './eventually';

interface Summary {
  ID: string;
}

interface Message {
  Subject: string;
  Text: string;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(new URL(`/api/v1/${path}`, stack.mailpit));
  if (!response.ok) throw new Error(`Mailpit GET ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** The subjects of the mails the address got about the order, sorted: no order is promised. */
export async function subjectsAbout(email: string, orderId: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${email}" "${orderId}"`);
  const { messages } = await api<{ messages: Summary[] }>(`search?query=${query}&limit=200`);
  const mails = await Promise.all(messages.map(({ ID }) => api<Message>(`message/${ID}`)));
  return mails
    .filter((mail) => mail.Text.includes(`Order ${orderId}`))
    .map((mail) => mail.Subject)
    .sort();
}

/** Until the address has `count` mails about the order; more than that fails the caller. */
export function untilMailed(email: string, orderId: string, count: number): Promise<string[]> {
  return eventually(
    () => subjectsAbout(email, orderId),
    (subjects) => subjects.length >= count,
    { what: `${count} mail(s) to ${email} about order ${orderId}` },
  );
}
