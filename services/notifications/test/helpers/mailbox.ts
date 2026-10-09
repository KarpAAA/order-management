// What the mail server of the run took, read through Mailpit's HTTP API. The server is shared
// by every test file, so a test asks by recipient, and gives each of its users an address of
// its own (`newRecipient()` in events.ts).
import { inject } from 'vitest';

import { waitFor } from './waiting';

export interface ReceivedMail {
  /** The `Message-ID` header, without the angle brackets. */
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
}

interface Address {
  Address: string;
}

interface Summary {
  ID: string;
}

interface Message {
  MessageID: string;
  From: Address;
  To: Address[];
  Subject: string;
  Text: string;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(new URL(`/api/v1/${path}`, inject('mailpitUrl')));
  if (!response.ok) throw new Error(`Mailpit GET ${path} answered ${String(response.status)}`);
  return (await response.json()) as T;
}

/** Every mail the server took for the address, oldest first. */
export async function mailsTo(email: string): Promise<ReceivedMail[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const { messages } = await api<{ messages: Summary[] }>(`search?query=${query}&limit=200`);
  const mails = await Promise.all(messages.map(({ ID }) => api<Message>(`message/${ID}`)));
  // the search answers newest first
  return mails.reverse().map((mail) => ({
    messageId: mail.MessageID,
    from: mail.From.Address,
    to: mail.To.map((to) => to.Address),
    subject: mail.Subject,
    text: mail.Text,
  }));
}

/** Until the server has taken `count` mails for the address. */
export function waitForMails(email: string, count = 1): Promise<ReceivedMail[]> {
  return waitFor(
    () => mailsTo(email),
    (mails) => mails.length >= count,
    { what: `${String(count)} mail(s) to ${email}` },
  );
}
