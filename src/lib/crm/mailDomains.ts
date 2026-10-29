/**
 * Our own mail domains, the one list for the app and the data pipeline
 * (`data-pipeline/src/lib/mailDomains.ts` re-exports it). A sender at one of
 * these is a colleague, never a banker: it never gets a deal link
 * (`DealContactService`), is tagged [internal] for the ingest LLM, and mail
 * among only these domains is dropped as internal.
 *
 * A domain added here only changes new mail. To clear what was ingested
 * before it joined, run `pnpm --filter data-pipeline refilter-internal-mail
 * --domain <domain>` (dry run first, then `--apply`).
 */
export const INTERNAL_MAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
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
  // only in the pipeline's PERSONAL_MAIL_DOMAINS. Including them makes
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
  'samantha.id',
  'beraucoal.co.id',
  'essensrenewable.com',
  'sinarmasland.com',
  'banksinarmas.com',
  'energigroupindonesia.com',
  'gear.com.sg',
  'starwealth.vip',
]);
