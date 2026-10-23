# CRM banker insights (per-person interactions and deal links)

For one CRM contact (a person, never a firm) and each team member, the app
shows emails each way and the last email; for the contact as a whole, last
contact and how many team members deal with them; and the companies the person's own emails were about. Two bankers at
the same firm always get their own numbers. Everything is scoped to the active
workspace. Interactions are **email only**: calendar invites are not ingested
and meetings are not counted.

Read path: `GET /api/crm/correspondents/[id]/insights` →
`ContactInsightsService.getContactInsights` (404 via `ContactNotFoundError` when
the contact is not visible in the workspace) → `ContactInteractionRepository`.
`ContactInsightsService.getInteractionSummaries(ids)` is the bulk form for
tables: a fixed number of queries for any number of contacts. Client wrapper:
`getContactInsights` in `src/lib/api/contactInsights.ts`. The response also
carries `contact` (`id`, `name`, `email`, `title`) so the panel header does not
depend on what its opener passed.

**Display text is decoded at the server DTO boundary.** Stored CRM text can
hold ingest's HTML entities (`&amp;`, `&amp;amp;`, `&#39;`, `&quot;`, `&lt;`,
numeric and hex). `decodeHtmlEntities` (`src/lib/crm/displayText.ts`) decodes
the named entities `&amp; &lt; &gt; &quot; &apos; &nbsp;` and numeric/hex
ones, repeating until stable for at most three passes. It leaves a plain `&`,
`<`, quotes and non-Latin text alone, and keeps out-of-range code points as
written. `&nbsp;` becomes a plain space. It is applied in:

- `BankerListService`: name, title, firm.
- `ContactInsightsService`: contact, team member names, related companies.
- `DealContactService`: deal and suggestion names, before sorting.
- `CrmSuggestedQuestionService`: template inputs before clipping, and stored
  question text.
- `get_crm_contact`: name, firm, industry, filled fields.

`crm_banker_insights` reads those services, so its output is decoded too. The
panel also decodes its opener's seed, which can come from the Firms view's
raw data. The result is plain text that React escapes; never pass it to
`dangerouslySetInnerHTML`. Search (`q`) still matches the stored text: the data
itself is fixed separately (MB-852).

## Who is a pair

- **Team member**: an app user (`users`) who is a member of the workspace the
  email is attributed to (custodian bridge: `email_workspace`). On participants this is the row's `user_id`, set by
  ingest when the address equals `users.email` at ingest time.
- **Contact**: a participant row with `correspondent_id` and no `user_id`, at a
  different address than the team member. A personal-domain attendee with no
  CRM contact never forms a pair.

## Emails — `analytics.mart_contact_interactions`

Materialized, one row per (`workspace_id`, `correspondent_id`, `user_id`),
refreshed with the other marts after each ingest (`MART_VIEWS`). It holds no
`now()`-relative columns.

- `emails_from_us`: distinct emails where the team member is `from` and the
  contact is `to`/`cc`.
- `emails_from_them`: distinct emails where the contact is `from` and the team
  member is `to`/`cc`.
- `last_email_at`: latest `sent_at` among those.

Two people who are both only recipients of an email are not an interaction;
`bcc` is never counted.

### Per-contact totals — `analytics.mart_contact_email_totals`

Materialized, one row per (`workspace_id`, `correspondent_id`), refreshed with
the other marts. Same pair rule, but `emails_from_us` / `emails_from_them`
count **distinct emails** across the whole team: an email counts for the
contact when it pairs with at least one workspace member, so one email from
the contact to two colleagues is one email here and one in each colleague's
row above. `last_email_at` is the latest of those emails. Tables that sort
contacts by email volume read this mart.

## Totals

| Field | Meaning |
|---|---|
| `lastContactAt` | the contact's last email (`mart_contact_email_totals`) |
| `totalEmailsFromUs` | distinct emails our team sent this person (`mart_contact_email_totals`) |
| `totalEmailsFromThem` | distinct emails this person sent us — one email to two colleagues counts once (`mart_contact_email_totals`) |
| `teamMemberCount` | members with at least one email |
| `hasSyncedData` | false when no email is attributed to the workspace at all |

Dates with no data are `null` and render as "—", never 0.

## Related companies

Person-level: related-company evidence (`analytics.employer_related_company_evidence`)
whose email this contact took part in, in any role, and whose email is
attributed to the workspace. Same visibility as the firm card: not dismissed,
resolved to a company. One row per (contact, company) with the evidence count
and the latest evidence email's date.

## Deal links

Which Brain deals a banker (one person) brought or was involved in. Stored in
`public.deal_contacts`, one row per (`workspace_id`, `company_id`,
`correspondent_id`): `role` `source` (brought the deal) or `involved`;
`origin` `email_attachment` / `manual` / `confirmed_suggestion`; `status`
`active` or `dismissed`; `evidence_message_id` for attachment links. The app
never deletes a row: remove and dismiss set `dismissed`, and that row is what
keeps every automatic path from adding the pair again. Links only join
companies of the same workspace; the contact must be visible in it
(`workspace_correspondents`).

Code: `DealContactRepository` → `DealContactService` (container key
`dealContactService`). Routes under `/api/crm/correspondents/[id]/deals`:
`POST {companyId, role}` (manual add), `DELETE …/[companyId]` (remove =
dismiss), `POST …/[companyId]/confirm`, `POST …/[companyId]/dismiss`. Client
wrappers: `src/lib/api/contactDeals.ts`. The links and suggestions are read
through `getContactInsights` (`deals`, `dealSuggestions`).

**Automatic links from Smart Files.** The pipeline sends the email's
`messageId` in `email_context`; `processUpload` stores the sender address and
Message-ID on the file (`files.source_sender_email`, `files.source_message_id`
— never the subject or name), and once the file's `matched_companies` are
written calls `DealContactService.linkFromSmartFile(fileId)`. For each company
of the workspace on the file and each visible contact at the sender's address:
`source` when the company was created from that file (company log
`auto_created_from_file:<file>` or `created_from_file:<file>`), else
`involved`. Senders that are app users or at an `INTERNAL_MAIL_DOMAINS` domain
(`src/lib/crm/mailDomains.ts`; the pipeline re-exports the same list) never get
a link. It is one `INSERT … SELECT … ON CONFLICT DO NOTHING`, so it
is idempotent and never touches an existing row of any status. A failure is
logged and never fails the upload.

**Late contacts.** When the sender has no CRM contact yet (the CRM ingest runs
in the pipeline and may create it after Smart Files processed the file),
nothing is written. `reconcileSmartFileLinks({ correspondentIds? })` runs the
same statement across the workspace's files, narrowed to those contacts' sender
addresses (`idx_files_workspace_source_sender`), at most
`SMART_FILE_LINK_RECONCILE_LIMIT` links per call. When it runs:

- **Per contact, on read**: `listContactDeals` (and
  `listDealsOfVisibleContact`, its body for a contact already found, which
  `getContactInsights` uses) runs it for its contact before reading, so the
  link appears the first time anyone opens that person.
- **Workspace-wide, daily**: only the `crm-suggested-questions` cron runs it
  with no ids, per workspace, in `CrmSuggestedQuestionService.runDaily` before
  generating that workspace's questions (best-effort; a failure is logged and
  reported as `reconcileFailedWorkspaces`, and generation still runs). No read
  path runs
  the workspace-wide variant. So until the next cron, the banker list's deal
  columns, deal filters and deal sorts can miss a link whose contact appeared
  after its file was processed. The panel and the scorecards already show it.
  The pipeline's post-ingest call (see "Relationship overview") refreshes
  overviews, which run `listContactDeals` and so reconcile each refreshed
  contact; it does not run the workspace-wide variant.

**Suggestions** are computed on read, never stored: related-company evidence
whose email the contact took part in as an external participant (any role),
attributed to the workspace, resolved to a company of the workspace, for pairs
with no `deal_contacts` row at all. Confirm writes an active `involved` link
(`confirmed_suggestion`) — or leaves an already active link alone, so a
`source` is never downgraded. Dismiss writes or sets a `dismissed` row
(origin `manual` when there was none).

**Manual wins.** Add (`manual`, either role) overwrites any existing row,
including a dismissed one. Remove dismisses.

## Scorecard

Per banker (one person), from **active** `deal_contacts` links only.
`BankerScorecardService` (container key `bankerScorecardService`);
`getContactInsights` returns it as `scorecard` (all time).

- **Deals brought** = active links with role `source`; **deals involved** =
  role `involved`. Two bankers on the same deal are each credited by their own
  role.
- **Furthest stage** of a deal brought = the highest-ranked stage it has ever
  been in: its current `companies.pipeline_stage` plus every stage its
  `company_logs` show — both ends of a stage move (`PROMOTED_FROM_x_TO_y`,
  parsed by `parseStageDestination`; a demotion proves the deal was at `x`),
  `PROMOTED_TO_` / `RESTORED_TO_` / `RESURFACED_TO_`, and `DROPPED_FROM_x`.
  Ranked by `pipeline_stages.position` for the workspace, soft-deleted stages
  included; pre-pipeline buckets rank below L0 (discovered < market screening <
  Pending Confirmation). A key that is neither is ignored (the current stage
  stands if nothing ranks).
- **Reached L1** = the furthest stage is a stage positioned after L0 — any
  stage, deleted ones too, since it was live while the deal sat in it. A deal
  dropped afterwards still counts. Counted over deals brought only.
- **Conversion** = reached L1 ÷ deals brought; `null` (render "—") when
  nothing was brought, never 0%.
- **`stageBreakdown[].currentCount`** = of those deals, the ones sitting in that
  stage right now (`companies.pipeline_stage`) and not dropped. A current stage
  that is no deal's furthest stage gets no row of its own.
- **`stageBreakdown`** = deals brought by furthest stage, in pipeline order,
  labelled as the workspace names the stage.
- **`since`** (optional ISO date) keeps only deals whose company was created at
  or after it (`companies.created_at` — when the deal entered Brain); it
  applies to brought and involved alike, and `hasDealLinks` then means "any
  active link in the period".

`getScorecards(ids, { since? })` is bulk — a fixed three reads for any number
of bankers: `listForContacts`, the logs of the deals brought
(`CompanyLogRepository.findByCompanyIds`), and the stage list. It only reads:
`getContactInsights` reads the contact's deals (which reconciles their Smart
Files links) before the scorecard.

## Banker list (Bankers view, Brain Bots) and contact panel (UI)

The person-level list is `BankerListService.listBankers` →
`BankerListRepository`. Brain Bots always use it (`crm_banker_insights`
ranking and contact lookup). The CRM page shows it only behind the
**`CRM_BANKERS_VIEW_ENABLED`** flag (default off, toggled per workspace in the
admin Features tab), since prototype v2.4 has only the firm list:

- **Flag on**: a **Firms | Bankers** toggle leads the toolbar (`?view=bankers`
  keeps it across a reload). Bankers is one row per person
  (`src/views/crm/BankersTable.tsx`) with its own sort select and "Has linked
  deals" / "Active in last 30 days" chips; search, Last contact and Team are
  shared with Firms, Topics is Firms-only. A row opens the contact panel.
  Data: `GET /api/crm/contacts` (client wrapper `listBankers` in
  `src/lib/api/crmBankers.ts`), query params as below plus `team`
  (comma-separated user ids) and `clientTodayIso`; an unknown `sort` is a 400.
- **Flag off**: no toggle, `?view=bankers` lands on Firms, and
  `GET /api/crm/contacts` returns 404.

- **Params**: `q` (name, email or firm), `sort` (`recent` default |
  `deals_brought` | `reached_l1` | `team_members` | `emails`; anything else
  throws `InvalidBankerListSortError`), `lastContact` (the Firms presets from
  `src/lib/crm/lastContactRange.ts`, applied to the person's last contact),
  `teamUserIds`, `hasDeals`, `active30`, `page`, `pageSize` (default 25, max
  100).
- **Result** `{ rows, total, totalUnfiltered, sort, page, pageSize,
  hasDealLinks, hasSyncedData }`. `reached_l1` falls back to `recent` when the
  workspace has no deal links. A row carries the person, firm, last contact,
  email totals, team member count, the top three team members, and deals
  brought / involved / reached L1 / conversion.
- **Visibility** = `CorrespondentRepository.search`: contact in
  `workspace_correspondents`, firm `employer_effective.curation_status =
  'published'`, names from the `*_effective` views.
- **Sorting, filtering and paging are SQL** (one page query + one count);
  ties break on last contact, name, then id. Emails and last contact come
  from `mart_contact_email_totals`, team from `mart_contact_interactions`.
  Reached L1 per deal is computed in SQL from the current stage or any stage
  the logs show (`STAGE_LOG_PATTERNS`), against the keys the scorecard puts
  after L0 (`pastFirstStageKeys`). Read-only: late Smart Files links are
  reconciled by the daily cron (see **Late contacts**).

"Which bankers give leads that reach L1?" is answered in chat: the Ask Brain
`l1_leads` question (shown once the workspace has deal links) and the
`crm_banker_insights` ranking. The Firms search matches a person's name or
email, so a banker is found through their firm card.

**Contact panel** (`src/views/crm/ContactInsightsPanel.tsx`) is a right-side
sheet opened from a contact's name or the Conversation action in a firm's
Contacts tab. It is mounted only while a contact is selected and keyed by its
id (`.claude/rules/dialog-open-state.md`), and fetches its own data behind a
request-id guard. Its layout (Overview / Related deals & companies / Deal
funnel) is described under **MB-681 contact deep dive**. Empty values show
"—", never 0.

## Brain Bots

The chat (analysis agent) and the Workforce read the same DTOs; nothing is
recomputed for the model.

- **`crm_banker_insights`** (`src/lib/agents/analysis/tools/crm_banker_insights.ts`)
  is in the shared `tools` base, `investmentTools` and `vcTools`, so every chat
  flavor and the Workforce have it next to `lookup_crm`. Workspace comes from
  `getActiveWorkspaceId()`; the schema takes no ids.
  - `mode: "contact"`, `contact` = name or email: resolved through
    `BankerListService.listBankers({ q })` (same visibility rule as the Bankers
    list; `q` also matches the firm, so a firm name returns its people). An
    exact name/email match wins; otherwise more than one hit returns a
    disambiguation list (name, firm, email) and stops. One hit renders
    `ContactInsightsService.getContactInsights`: per-team-member emails each
    way and last email, last contact; deals with
    current stage, the scorecard's furthest-stage breakdown, reached L1 and
    conversion; related companies. Suggestions are listed as unconfirmed, never
    as deals.
  - `mode: "ranking"`, `metric` ∈ `deals_brought | reached_l1 | recent_activity
    | team_members | emails`, `limit` (default 10, capped at 25),
    `active_within_days` (passed as the list's `custom` last-contact bound):
    the banker list's server-side sort, one line per person. The list silently
    falls back to `recent` for `reached_l1` without deal links, so the tool
    checks `hasDealLinks` and says the ranking cannot be computed instead;
    likewise interaction metrics with no synced data.
  - Unknown data is written as "no data (email sync may be off)" / "no deal
    links recorded", never 0, and the description tells the model to answer
    about the person only and say it does not know.
- Every flavor prompt lists it under `lookup_crm` / `crm_insights` (person-level
  and ranking questions → `crm_banker_insights`, firm-level → `lookup_crm`), and
  `lookup_crm`'s own description points to it.
- **`get_crm_contact`** (`@crm_contact`) ends its brief with "Relationship with
  our team" (team members with counts, totals, last contact, deals) from `getContactInsights`, labelled context-only. A failed insights
  read degrades to "no data" and never costs the run its brief.

## Ask Brain

Daily suggested questions on the CRM page (MB-861, MB-862). `CrmSuggestedQuestionService`; no LLM. Every question is a template
filled with the **asking user's own** data in the active workspace, and never
another user's or another workspace's.

- **Data**: `ContactInteractionRepository.listUserContactActivity(workspaceId,
  userIds, now, since)`. In one query it returns each (member, visible contact)
  pair with:
  - all-time emails from the mart;
  - emails in the last 14 days. The mart has no per-period
    counts, so the 14-day email count is read live from `analytics.emails`.
    It uses the mart's pair rule verbatim, so change the two together.

  Contacts are the banker list's visible set: the contact is in
  `workspace_correspondents` and its employer is published. Two other inputs
  feed the questions: `deal_contacts` rows for those contacts, and the user's
  own `user_workspaces.is_email_synced`.
- **Personalized**: only when the user's own sync is on; without it the set
  has no personalized questions. Stable order, at most 4, ≤ 70 chars with names clipped at a
  word boundary; the firm is kept whole or dropped:
  1. "What's the latest with {banker} ({firm})?": the banker with the most
     emails with me in the last 14 days.
  2. "Should I follow up with {banker}? Last contact {n} days ago.": my top
     banker by all-time interactions among those whose last contact with me is
     more than 30 days ago.
  3. "How is {deal} from {banker} progressing?": the most recently created live
     deal brought (`source`, active link, company not dropped) by a banker I
     interact with.
  4. "Which bankers give leads that reach L1?": only when the workspace has an
     active deal link and the user has any interaction data.
  5. "Who on our team covers {firm}?", where {firm} is the firm I interact with
     most (all-time emails).
- **Generic**: always the same three (`genericQuestions(hasSync)`); none is
  filled from data:
  - "Summarize this week's contact sync" when my sync is on; otherwise "Who
    should I follow up with this week?".
  - "Which bankers are most active with us?".
  - "Which firms did we email most this month?".

  A stored row's `generic` is ignored on read and rebuilt from its `hasSync`.
  Older rows kept a data-filled question there.
- **Day key**: the Asia/Jakarta date (`askBrainDate`). Rows live in
  `crm_suggested_questions`, unique per (workspace, user, `for_date`), with
  `questions = { personalized, generic, hasSync }`.
- **Cron** `GET /api/cron/crm-suggested-questions` runs at `0 22 * * *`
  (05:00 WIB), so it writes the new WIB day.
  - It works like `task-reminders`: `sweepWorkspaces`
    (`src/lib/server/cron.ts`) lists every live workspace, and each gets its
    own container and its own try/catch.
  - Per workspace it calls `CrmSuggestedQuestionService.runDaily`, which first
    runs the workspace-wide `reconcileSmartFileLinks()` (see **Late
    contacts**), so the questions see the new links, then
    `generateForWorkspace`. The response counts the links as `reconciled`.
  - `generateForWorkspace` uses five queries however many members there are:
    members, activity for all members, the workspace link check, links for all
    contacts involved, and one bulk upsert. It writes rows only for members
    with personalized questions (see **Never saved**).
  - It runs inline with no `jobs` row, like the other crons, because the work
    is bounded and has no LLM. A missed day is covered on read.
- **Never saved**: a set with no personalized questions (sync off, or no
  usable data). Saving it as today's row would hide the user's last
  personalized questions behind a generic-only day. This holds for both the
  cron and on-demand generation, and costs no extra query.
- **Read** `GET /api/crm/suggested-questions` →
  `{ personalized, generic, hasSync, stale }` for the session user (401
  without one).
  - If today's row exists, it is returned.
  - Otherwise the questions are generated, and saved on demand when they have
    personalized ones. A failed save still returns the fresh questions.
  - If generation fails, the latest earlier row is returned with
    `stale: true`; if there is none, generic questions only.
  - If generation succeeds with no personalized questions, the latest saved
    row's personalized questions are returned with `stale: true`, if it has
    any. The generic three and `hasSync` come from the fresh read. Generic
    only, with no personalized questions, happens only when nothing
    personalized was ever saved.
- **UI**: `AskBrainRow` is the "Ask Brain Bot" card above the firm list
  (prototype v2.4, "Personal & private").
  - It shows 4 question tiles (2 personalized + 2 generic, or up to 4
    generic) and an "Other" tile that opens the composer empty. There is no
    "Show more" and no collapse.
  - Loading placeholders keep the card's height.
  - With no personalized questions and my sync off, it adds a "Connect email
    for personalized questions" link (`data-testid="ask-brain-connect-email"`).
    The link opens a popover: "Email sync is turned on by a workspace admin in
    the Admin Portal.", with an "Open Admin Portal" link to `/admin-portal`.
    There is no self-serve sync flow.
  - The contact panel has its own "Ask Brain Bot" pills (built in the view,
    `conversation/shortcuts.ts`): Summarise relationship, Draft follow-up
    email, "{first}'s view on {deal}" (an active linked deal, else "Open
    questions for {first}"), "Why {first} passed on {deal}" (a dropped one,
    else "Intro paths via {first}") and "Ask something else" (empty
    composer).
  - A chip click calls `prefillComposer` and then `focusCopilot` (on mobile,
    the chat route) and `focusComposer`. **It never sends.** The panel closes
    itself so the composer is reachable.

## MB-681 contact deep dive

The contact panel is the prototype v2.4 "Conversation notes" modal (a centred
dialog; header, Ask Brain Bot pills and tabs stay put, the tab body scrolls):

- **Overview** — Role in investment, the Relationship overview, and three
  tiles (interactions, last touch, team members). The Team members tile opens
  the per-teammate breakdown (emails each way, last email). Below, a folded
  "Show conversation notes" lists the notes the overview was built from (20 per
  page, "Load more"), so a reader can check the AI text. The prototype has
  neither; both are kept on purpose.
- **Related deals & companies** — linked deals: name, `geography · segment ·
  Opened <month>` (`ContactDealLink.geography/segment/openedAt`), stage
  ("Passed at …" when dropped), and the overview's line on the contact's part
  in that deal (`overview.dealNotes`), or "Brought by …" / "… involved" when
  there is none. The Link deal / remove controls under the list are the only
  place a deal link is made; email-matched suggestions to Confirm / Dismiss;
  related companies as tiles. The prototype's related-company relations
  ("Former employer · 2015–2021", "Board") have no source, so a tile shows the
  email count and last date.
- **Deal funnel** — furthest stage reached by the deals the contact brought,
  every live stage listed (zeros included), conversion from the previous
  stage, and a summary box of plain arithmetic (`summariseFunnel`), not AI:
  deals brought and how many reached the last stage, the biggest drop-off, and
  how many live deals sit in the two pipeline stages before the last
  (`currentCount`), named by their workspace labels.

The Firms list follows the prototype's columns: Source · Industry · PIC ·
Activity (last contact, with the response P50 under it; sorts by last contact)
· Topics · Team, then a Conversation icon (opens the panel for the primary
PIC), an edit pencil for the primary PIC (loads the firm detail if the row was
never expanded) and the expand chevron. The Contacts tab's columns are Name ·
Email / Phone · Area Focus · Industry Focus · **Profile** ("Get Full Profile"
runs `@crm_contact`) · Action, with a **Conversation** action that opens the
same panel.

### What is stored, and when

Email subjects and bodies are never stored (ephemeral pipeline). The ingest LLM
call that already reads each email in memory (`extract_email_info`) also returns
an `email_note`, and only that **paraphrased** text is kept — never a quote:

- `analytics.email_notes` — one row per LLM-processed email: `summary` (NULL
  when the email has no business substance; the row still exists so it is never
  re-asked), `key_points` (≤4), `next_step`, `next_step_status`
  (`action`/`done`/`none`), `sentiment`, `model`. An email with no business
  substance (scheduling, admin, "thanks") has a NULL summary and no next step
  — the sanitizer enforces it.
- `analytics.email_role_signals` — per external participant address:
  `label` (`funding`/`lending`/`finance`/`tax`/`advisory`/`legal`, plus
  `due_diligence` for third-party diligence providers, `principal` for the
  target's or seller's owners and management, and `other` for a clear deal
  role none of those fit), `confidence`, one-sentence `evidence`. The label
  set is closed: the model cannot invent a label, and an `other` signal's
  evidence names the role so recurring ones can be promoted to a label. Roles naming an internal or unknown
  address are dropped before insert. A signal belongs to the contact whose
  `email_participants` row on that email has the same address.

**Thread context.** A note is per email, but a reply alone ("agreed, go with
option 2") says little. The parser keeps the quoted history that `cleanBody`
cuts off (`extractQuotedThread`: the `>` lines and everything from the reply
intro on, at most 3,000 characters, most recent message first). The prompt
carries it as `EARLIER IN THREAD`, for the note only: the note covers what this
email adds, and a role still needs evidence in this email. Topics and related
companies must not come from it, because every reply quotes the original pitch.
The model does not always comply, so `dropThreadOnlyCompanies` also drops any
related company the email's own subject and body do not name. The quoted text
is never stored, and the note's readers (the email's From/To/Cc) all received
it in that same email.

**Backfill.** Already-ingested emails skip the LLM. When an MBOX is processed
again, each duplicate email with no `email_notes` row gets one note-only call.
A failed backfill call is logged and retried on the next re-run; it never
blocks the offset or re-runs the CRM upsert.

### Reads

`ContactConversationRepository` scopes every read the same way as the MB-829
marts (custodian mailbox → `users` → `user_workspaces`), and the service 404s a
contact the workspace can't see. Notes are newest first with keyset pagination
on `(sent_at, email_id)`; team members for a page come from one batched query.
**Role in investment** is a SQL rollup over the stored signals at read time —
no LLM call. The line under the chips ("Inferred from N emails — …") is the
overview's `role_summary`, a sentence across every email; until one is
generated it falls back to the newest evidence sentence the viewer may see.

**`CRM_EMAIL_NOTES_ENABLED`** (default off) gates the notes list: while off,
`GET …/conversation` asks the service for no notes (`includeNotes: false`), so
the modal shows none. Roles, the overview and Brain Bot are unaffected.

**Email notes are private to the people on the email.** A teammate sees a
note only when they are on that email's From/To/Cc, or it is in their own
mailbox (the custodian: Bcc and list mail reach a mailbox that is not on the
header). `getConversation(id, viewerUserId)` always reads as the signed-in user
(the route 401s without one; Brain Bot uses the chat user and with no user
reads no notes). The **Role in investment** chips and counts cover every email,
but its evidence sentence comes only from an email the viewer may see (the
role summary is shared, like the overview). The
system reads (`listNotesForSystem`, `getRoleRollupForSystem`) serve only the
shared overview job and AI Workforce runs (`getConversationForWorkforce`, whose
tool output the trace redacts). The **Relationship overview** stays one shared
text built from the 30 newest notes, whoever was on them, and so do its
per-deal lines on Related deals: every teammate who can open the contact sees
them.

### Relationship overview

One LLM summary per (workspace, contact), cached in
`contact_relationship_overviews`, with `deal_notes` — one sentence per active
linked deal on the contact's part in it — and `role_summary` — one sentence on
their role in investment across all their emails (what they raise, what they
bring, who they pull in; first name, no guessed gender, no deal specifics) —
from the same call. The prompt tags
each note with the deals it is evidence for (related-company evidence the
contact is on, or the email a Smart Files link came from) by short refs
(`D1`…); the model returns null for a deal no tagged note speaks to, and that
deal gets no line. Only the 30 newest notes are read, so a deal discussed only
in older mail has none.

`input_hash` is `overviewInputHash` (`src/lib/crm/overviewInputHash.ts`):
`${noteCount}:${latestEmailId}` over the contact's notes, plus a digest of the
active deal links when there are any — linking or removing a deal makes the
overview **stale** too. Generation always claims the row first, in one
conditional upsert (`claimOverviewPending` for one contact,
`claimOverviewsPending` for a batch, ids sorted so concurrent claims cannot
deadlock), so two callers never generate the same overview; a `pending` row
older than 5 minutes counts as abandoned. Two paths generate:

- **After ingest.** When a pipeline invocation wrote email notes (fresh emails
  or backfill), it calls `POST /api/auth/crm-overviews/refresh`
  (`X-Api-Secret`; `{ workspaceIds, since }`, `since` = invocation start minus a
  minute) after the mart refresh — the prompt reads the interaction totals.
  Best-effort: a failure is logged and never fails the run.
  `refreshTouchedOverviews` reads the contacts on emails whose note was
  written since then (`listOverviewRefreshCandidates`, one query), keeps those
  missing or stale (failed ones at most hourly), claims up to 10 per workspace,
  newest activity first, in one statement, and runs them in one
  `contact_relationship_overview` job, two at a time; one contact's failure marks only its overview failed.
  The rest wait for the next run or a panel open.
- **On open.** Opening the panel on a stale/missing/failed overview calls
  `POST …/conversation/overview`, which claims and dispatches a single-contact
  job. The old text stays visible while a new one is generated, and the panel
  polls. The panel first fetches the conversation with `limit=1`: one note is
  enough to know there is something to summarise or list.

Role in investment needs no step of its own: the ingest LLM call writes its
signals with each note.

### Routes

- `GET /api/crm/correspondents/[id]/conversation?cursor=&limit=` (limit 1–50,
  default 20) → `ContactConversation`, with the notes the signed-in user may
  see; 401 without a session.
- `POST /api/crm/correspondents/[id]/conversation/overview` → `RelationshipOverview`.
- `GET /api/crm/correspondents/[id]/insights?period=all|30d|90d|ytd|12m` —
  `period` only changes the scorecard (deal funnel). Once a contact brought
  anything, `scorecard.stageBreakdown` lists every live pipeline stage, zero
  when no deal stopped there; `crm_banker_insights` prints only non-zero ones.

### Chat

`crm_banker_insights` (contact mode) includes Role in investment (with the role
summary, like `read_contact_emails`) and the 10 newest notes the chat user may see; in a Workforce run it reads every note. A
failed conversation read prints that both could not be read, never that there
are none. The viewer comes from the runtime config (`runtimeViewer` in
`src/lib/agents/runtimeViewer.ts`, shared with `read_contact_emails`), never
from a tool argument.
`get_crm_contact` returns no notes. The `@crm_contact` agent reads them
through its own `read_contact_emails` tool, uses them to anchor identity and
steer its web searches, and keeps live-deal specifics out of what it writes
(`crm-contact-fill.md`, "Private email context, shared result").

## Local fixture

`pnpm db:seed` adds two Golden Sacks bankers (Jimmy Sprinkles, Penny Ledger)
with different emails against `test@sqe.co.id` and Wendy Wobble, plus an email
from a team user outside the workspace that never counts. Deal links: Jimmy is `source` of Ember Renewables (L1, from an
email attachment), Cinder Foods (L0, manual) and Juniper AgriTech (manual;
logged L0 → L1 → L2 → L1, dropped at L1 — furthest stage L2, so his scorecard
is 3 brought, 2 reached L1); Penny is `involved` in Halcyon
Media (confirmed suggestion); Blue Harbor Logistics stays a suggestion for
Jimmy from his related-company evidence.

MB-681 conversation data on the same fixture (no LLM needed):

- `CRM_EMAIL_NOTES_ENABLED` is on for the combined workspace, so the notes
  list shows.
- Every j*/p* email has a note. Role in investment: Jimmy advisory (high) +
  funding; Penny lending (high) + finance.
- **Sally Bubbles** (JP Organ) gets a 24-email history over ~6 months split
  between Test User and Wendy (22 notes, so the notes list pages with "Load
  more"; two teammates in the Team members breakdown); roles tax / advisory /
  finance.
- Overview states: Penny **ready and fresh** (shows immediately), Sally
  **ready but stale** (old text, regenerates on open), Jimmy **none**
  (generates on first open). Opening Sally or Jimmy calls the real LLM.
