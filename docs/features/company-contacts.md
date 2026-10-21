# Company contact details (`@crm_contact`, company task)

The **Details** tab — on both the company dialog (`CompanyDetailDialog`) and the full-screen company page (`CompanyDetail`) — has a **Contact Details** card: the
company's partnership contacts — the CEO, a VP / Head of Business Development,
a Business Development Manager, or the closest equivalents — **as the CRM holds
them**. **Find contacts** (or **Find more**) queues an AI Workforce run that
researches the company's leadership on the web and files the best five into the
CRM. **Open in CRM** deep-links to the company's firm card in the CRM.

## Company ↔ CRM firm

A pipeline company and a CRM employer are the same thing when they match.
`CompanyContactDiscoveryService.resolveEmployer` checks, in order:

1. `companies.crm_employer_id` — the stored link;
2. the website's domain in `employer_domains` — the mailbox ingest's own
   identity key, so a company that has emailed the firm resolves to the
   employer those emails created;
3. the normalized name (`normalizeEmployerName`, the `employers.normalized_name`
   key) — rejected when the company has a domain and the same-name employer
   has domains of its own (they would have matched in step 2), so "Acme" the
   target never binds to "Acme" the bank.

Matches 2–3 are only *reported* on read. The first save makes the link durable:
it sets `crm_employer_id`, and creates the employer (`findOrCreateEmployer`)
when nothing matched. Only that newly created employer claims the website
domain (`ON CONFLICT DO NOTHING`); a name match is never given the domain,
since a wrong claim would misfile every future email from it.
`domainFromWebsite` refuses social and site-builder hosts (`linkedin.com`,
`facebook.com`, `*.wixsite.com`, …) so a company whose "website" is a profile
page can never capture that host's email.

## What happens when you press it

1. `POST /api/companies/:id/contacts` → `discover` puts a row on
   `ai_workforce_queue` with `agent_name = 'crm_company_contacts'` and
   `trigger_meta.company_id` (joins an in-flight run; per-minute idempotency key).
2. `src/lib/workforce/runAgent.ts` routes that agent name to
   `getCrmCompanyContactsAgentGraph` in `src/lib/agents/crm_contact/`.
3. The agent reads `get_company_for_contacts` (identity + the CRM firm's
   existing contacts), searches the web, checks its shortlist with
   `enrich_company_contact` (treg.to; phone only with `with_phone`), and calls
   `save_company_contacts` once.
4. `saveContacts` links the firm, then `CRMService.addContactsToEmployer` files
   the people: a match by email (across employers) or by name at the firm
   gets only its **empty** fields filled — never its name or email; everyone
   else is inserted as `origin='manual'`, `source='crm_contact'`, with a
   workspace membership. Batched; nothing is ever deleted. An email match under a
   *different* firm stays there (the CRM keys people on email); the save
   reports it to the agent, and the person does not show on this card.
5. The card polls `GET /api/companies/:id/contacts` — firm, top 5 contacts and
   total count, latest run — every 4s while the run is active (5 min cap).

## Who the search looks for

The agent's prompt (`PARTNERSHIP_ROLE_MIX` in `companyContactsPrompt.ts`) asks
for up to five people **spread across levels** rather than five from one tier:
one CEO, one business development lead (VP / Director), two business
development staff (manager / associate / analyst) and one sales contact. It is
guidance to the agent only — nothing in the data model or the save enforces it,
and the contacts stay a flat list.

## Ranking

The card ranks **all** the firm's CRM contacts — ingested, imported, hand-added
or agent-found — by `partnershipRoleRank(title)` (`crm_contact/constants.ts`):
CEO / MD / founder → CBO / CCO / CSO → VP or Head of BD / Partnerships →
BD / Partnerships Manager → country or BU GM → other C-level → everyone else.
It shows the top five and links to the rest in the CRM. The agent's search
prompt (`PARTNERSHIP_ROLE_MIX`) asks for a spread across levels; ranking here
is display-only.

## AI-Discovered Companies table

The Sourcing page's **AI-Discovered Companies** table (`MarketScreeningResults`)
has a **Contact** column in place of Revenue / EBITDA / Valuation: each
company's top-ranked contact (name, title, email / phone / LinkedIn), with
**See more** expanding the rest of the top five inline and a link to any
beyond that in the CRM.

- **Auto-enrichment.** When a market scan inserts companies,
  `runMarketScreening` calls `discoverMany` on them, so each new company gets a
  contact search queued without anyone pressing a button. Best-effort: a queue
  failure is logged and the scan still succeeds.
- **One request per page.** The table loads its visible page through
  `GET /api/companies/contacts?ids=…` → `getStates`, the batched `getState`:
  a fixed handful of queries whatever the number of companies
  (`findByIds`, `findLatestByCompanyIds`, `findManyByDomains`,
  `findByNormalizedNames`, `findByEmployerIds`). `resolveEmployers` mirrors
  `resolveEmployer`'s precedence — keep the two in step. The page re-polls
  every 5s while any visible company's search is active.
- **Backfill.** **Find missing contacts on this page** posts the visible
  page's ids (10, the endpoint's `MAX_BULK_CONTACT_DISCOVERY` cap — each is an
  agent run) to `POST /api/companies/contacts` with `onlyMissing: true`; the
  server skips companies that already have contacts, a run in flight, or a
  succeeded search, so a second click never pays twice. A scan's
  auto-enrichment queues in batches of the same size.
  A row without contacts also has its own **Find contacts** / **Search again**.
