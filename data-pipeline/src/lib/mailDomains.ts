/** Shared mailbox domain policy for classify + privacy filter. */

export { INTERNAL_MAIL_DOMAINS } from '@/lib/crm/mailDomains';

export const PERSONAL_MAIL_DOMAINS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);
