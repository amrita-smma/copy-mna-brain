/** Shared mailbox domain policy for classify + privacy filter. */

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

export const INTERNAL_MAIL_DOMAINS = new Set<string>([
  'starcapital.co.id',
  'starcapitalholdings.com',
  'smma.id',
  'sinarmasmining.com',
  'techconnect.co.id',
  'starhousecapital.sg',
  'frontiergroup.sg',
  'hosanco.com',
  'ebergroup.com',
  'partners97.com',
  'kbru.co.id',
  // Do NOT list public consumer domains here (e.g. outlook.com) — they belong
  // only in PERSONAL_MAIL_DOMAINS. Including them makes
  // analyst@starcapital.co.id ↔ banker@outlook.com look "internal_only" and
  // the privacy filter silently drops deal mail.
  'starinvestama.co.id',
  'sunterra.id',
  'theolivelink.com',
  'sinarmas.co.id',
  'sinarmas.org',
  'startechgv.com',
  'aldiracita.com',
  'adivira.com',
  'lifewithsun.com',
]);
