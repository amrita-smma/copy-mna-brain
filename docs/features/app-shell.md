# App shell (chat-first landing + center console)

The product is chat-first: the Copilot is the landing page, and the left sidebar
carries both of the app's navigations — chat history and the page list — behind a
two-tab toggle. Pages open in a center console beside the Copilot.

- **One shell, mounted once.** `src/components/layout/AppShell.tsx` is rendered
  by `src/app/w/[workspaceSlug]/layout.tsx`, above the routed `children`. That
  placement is the whole design: switching tabs is a Next.js soft navigation
  that swaps only the page, so the sidebar, the Copilot pane, and any in-flight
  chat stream stay mounted. (The shell used to be `DashboardLayout`, wrapped
  *inside* each of 13 views, which remounted everything on every navigation.)
  Views therefore render bare content — no view wraps the shell.
- **Two states.** On the landing (`/w/<slug>` and its `/w/<slug>/chat` alias)
  the Copilot fills the console; `AppShell` derives that from the route rather
  than writing it to storage, so the state can't leak onto the next page.
  Collapsing the Copilot navigates to `layout:last-tab` (or the first
  feature-enabled page). On a page route the page fills the console with the
  Copilot docked right; expanding it keeps the URL, so collapsing returns to the
  same page. The only chrome over the console is the full-screen toggle.
- **One sidebar, two tabs.** `ChatSidebar`
  (`src/components/chat/ChatSidebar.tsx`) opens with a **History / Pages**
  segmented toggle above the "New Chat" button, and shows one list at a time:
  chat history, or the app's destinations (`SidebarPagesNav`). The choice
  persists under `layout:sidebar-section`. This replaced a strip of icon tabs
  across the top of the console — two competing navigations pointing in
  different directions, which read as one confusing bar. Choosing a page calls
  `revealConsole()`, because the Copilot may be sitting full-screen over the
  console and navigating behind it would look like nothing happened.
- **Page registry.** `src/lib/navigation/consoleTabs.ts` holds `CONSOLE_TABS`
  (slug, path, label, feature flag, purpose) and is deliberately free of UI
  imports, because the Copilot's `navigate_page` tool builds its argument enum
  from it. `SidebarPagesNav` (`src/components/layout/SidebarPagesNav.tsx`)
  attaches the `lucide-react` icons and renders the list as real
  `<WorkspaceLink>`s. `visibleConsoleTabs(flags)` is the single flag filter,
  shared by that list and by `AppShell`'s collapse target, so the two can't
  disagree about which pages are reachable.
- **`LayoutControlContext` wraps the whole shell** and carries the three actions
  that move the two panes past each other:
  - `revealConsole()` — docks the Copilot. Called by anything in the transcript
    that sends the user to a page (the "Open X" navigation chip, a company
    chip). Without it the console would swap pages *behind* an expanded Copilot
    and the click would look like it did nothing.
  - `expandCopilot()` — puts the Copilot full-screen. Called by every "New chat"
    trigger and by selecting a chat from history, so opening a conversation
    lands the user in it rather than in a 384px docked column (or, on a tab
    route with the pane collapsed, nowhere visible at all).
  - `focusCopilot()` — the existing "Analyze using AI" path.

  The provider wraps the entire shell rather than just the panes because the
  sidebar's "New chat" buttons live outside `SidebarInset`. It returns no-ops
  outside the shell, so `ChatSidebar` still works in the mobile history drawer.
- **Company mentions become "Open &lt;company&gt;" chips.** When the Copilot's
  answer names a company, the transcript renders a chip that opens it at
  `/companies/<id>`. This replaced a chip that recorded the `navigate_page`
  destination ("Open Pipeline") — a tab the user can already see — with
  something specific enough to act on. The `navigate_page` skill itself is
  unchanged and still navigates on a live call.

  Getting an id for a name is the interesting part. The client never sees a
  tool's raw table — it sees the model's prose answer, which names companies but
  carries no ids, so there is nothing to build a URL from. (`query_companies`
  does print an `ID` column for the *model* to hand to the export tools; that
  column is not what the chip renderer reads.) Rather than guess or re-query by
  name, the company-returning tools append a hidden `COMPANY_MENTIONS_JSON`
  manifest of `{ id, name }` pairs
  (`src/lib/navigation/companyMentions.ts`), and the client keeps only the
  entries whose name appears in the answer's own prose. That filter matters: one
  query can return fifty rows, and chipping all of them would bury the answer.
  Matching is case-insensitive and word-boundary anchored, so `Acme` does not
  light up inside `Acmetric`.

  Because the chips are a pure function of the prose, the model's writing style
  decides whether they appear at all — and the failure mode is a summary. "12
  active deals at L1, mostly Japanese industrials" names nobody, so it produces
  no chips and no way to click through. `COMPANY_MENTIONS_PROMPT_GUIDE` (same
  file, appended to every chat flavor that has company tools) biases the model
  toward landing every count, breakdown and ranking on named companies, written
  exactly as the tool returned them. It lives next to `selectMentionedCompanies`
  on purpose: the rules it states *are* the matcher's rules, and
  `companyMentions.test.ts` asserts the guidance's own worked examples really do
  chip, so the advice can't drift away from the implementation.

  `companyDetailPath` (`src/lib/navigation/companyPath.ts`) is the single place
  the destination is encoded. `/companies/<id>` and `/pipeline/<dealId>` render
  the same `CompanyDetail` view — both segments are the company id — the
  difference being that the pipeline route frames the company as a deal in the
  funnel. Mentions with no id (a file's `matched_companies` can hold bare name
  strings) stay inert badges rather than linking to `/companies/undefined`.
- **Chat history pages in as you scroll.** `GET /api/copilot/chats` returns 30
  chats at a time (`limit`/`offset`, clamped server-side) rather than every
  conversation the account has ever had — `CopilotChatsService.list` reads
  `limit + 1` rows and drops the extra, so `hasMore` costs nothing beyond the
  page itself. `ChatSidebar` renders a zero-height sentinel under the last row
  and appends the next page when an `IntersectionObserver` sees it, 200px before
  it reaches the viewport. `ChatProvider` owns the paging state: `loadMoreChats`
  guards re-entry with a ref (the sentinel can fire again before React commits
  the loading flag) and dedupes appended rows by id, since a chat touched
  between two page loads moves up the ordering and would otherwise arrive twice.
  `refreshChats` re-reads as many chats as are currently on screen instead of
  just the first page, so a title landing mid-session doesn't collapse a list
  the user has already scrolled through. The `last_active_at DESC` ordering
  carries an `id DESC` tiebreak — chats touched in one transaction share a
  timestamp, and without it a row can straddle two pages while another is never
  served.
- **Empty chat.** There is no greeting screen: an untouched thread is the same
  transcript view, empty, with the composer where it always is, so the first
  messages render into it in place instead of swapping screens. The starting
  prompts (`ChatSuggestionsCarousel` in `ChatSuggestions.tsx`) drift right to
  left in a slow seamless carousel above the box — pausing under the pointer,
  scrolling by hand under reduced motion — with a small × in the send button's
  column that folds them away into it; the sparkle it becomes brings them
  back, and the fold is remembered per browser (`copilot.suggestionsCollapsed`).
  It stays through the conversation (the chips are shortcuts, not a landing)
  and appears once the thread's history has loaded.
- **Streaming reaches React in batches, and only the transcript takes them.**
  `useChat` runs with `experimental_throttle` (50 ms), so a reply commits a
  few renders a second rather than one per token. `ChatProvider` publishes
  no catch-all value: `useChatMessages()` carries the transcript and is read
  by the transcript and the navigation handler only; `useChatStatus()`
  carries `status` and the turn's `activity` (thinking, working, talking,
  derived once in the provider from the last assistant message), which is
  what the bot avatars and thought clouds follow; `useChatThread()`,
  `useChatComposer()` and `useChatActions()` change on bot switches, user
  input and never. Anything that must act on the whole finished turn — not
  on whatever batch the transcript has shown so far — subscribes with
  `useChatActions().onTurnFinished`, which the SDK calls with the complete
  message before the last batch is delivered.

## Mobile shell (PWA) and the profile page

On a mobile viewport `AppShell` drops the sidebar and the docked Copilot
entirely and renders `MobileShell`
(`src/components/layout/MobileShell.tsx`) — a full-bleed frame with an
Instagram-style bottom nav (`MobileBottomNav`) and four destinations: Activity
(`/dashboard`), Chat (the full-screen Copilot), Search (`/master-data`) and
Profile (`/profile`).

- **Profile is a page, not a sheet.** The Profile tab used to open the workspace
  switcher bottom sheet and nothing else — tapping it never navigated anywhere.
  It is now an ordinary `<WorkspaceLink>` to `/w/<slug>/profile`, rendered by
  `src/views/Profile.tsx`: the user's name and avatar, a workspace selector
  under the name, then "&lt;Name&gt;'s items" — large tappable cards for the
  decisions waiting on them, the companies they own, and the insights they
  wrote. Log out moved onto this page.
- **Desktop reaches the same page from the `…` account menu** in the sidebar
  footer (`SidebarUserFooter`), alongside Send Feedback and Theme — that menu
  item is the only entry point outside mobile. The page then hides its workspace
  selector and its log-out button, because `WorkspaceSwitcher` in the sidebar
  header and "Sign Out" in that same menu already own both; a second copy would
  be a second source of truth for switching workspaces. The gate is
  `useIsMobile`, the same hook and breakpoint `AppShell` uses to choose a shell,
  so the page and the chrome around it cannot disagree.
- **The switcher became a reusable drawer.** `MobileWorkspaceDrawer`
  (`src/components/layout/MobileWorkspaceDrawer.tsx`, formerly
  `MobileWorkspaceSwitcher`) still owns the membership fetch, the
  `switchWorkspace` + hard-navigate behaviour and the 50vh sheet, but takes its
  trigger via `renderTrigger`, which also receives the resolved current
  workspace so the trigger can label itself without a second fetch. The profile
  page passes a dropdown-looking control; nothing else triggers it.
- **One request for the whole page.** `GET /api/profile/items` →
  `ProfileService.getMyItems` (`src/lib/services/profileService.ts`) assembles
  all three sections in a **fixed six queries** regardless of row count:
  `CompanyRepository.findOwnedByUser`/`countOwnedByUser` (assignee, Deal Sponsor
  or Deal Captain, resolved in one `LEFT JOIN` pre-filtered to the user so a
  company can't fan out into several rows),
  `InsightRepository.findPageWithCreator`/`countByFilter` with the existing
  `createdBy` filter, `CompanyVoteRepository.listOpenBallotsByVoter` (a `draft`
  ballot on an `active` session, company joined on) and
  `AiWorkforceQueueRepository.listAwaitingDecisionByUser` (runs in
  `waiting_for_human_input` the user may decide — the same two deciders
  `InterventionRecipientService` resolves). The cards must never fetch per row;
  batch new data into this endpoint instead.
- **The user comes from the session.** The route takes no `userId` param, so one
  member cannot read another's queue. Action items carry `companyId`/`taskId`
  rather than URLs — the view builds the hrefs (a vote opens
  `/pipeline/<id>?tab=voting`, an approval opens
  `/ai-workforce/tasks/<id>`), keeping route knowledge out of the service.

## Page-aware Copilot skills

Two chat-only tools connect the conversation to the console beside it. Both are
in `chatOnlyTools` — a Workforce run has no browser, so neither reaches it.

- **`navigate_page`** moves the console. The tool emits a
  `<!-- NAVIGATE_PAGE_JSON:{…} -->` marker (same pattern as
  `propose_workforce_handoff`); the format lives in
  `src/lib/navigation/navigateAction.ts` so the client can parse it without
  pulling LangChain into the browser bundle.
  `src/components/chat/NavigationActionHandler.tsx` performs the navigation, and
  the interesting part is *not* navigating: the marker is persisted in the tool
  output and so re-renders forever. Each chat starts with a baseline of the
  `nav_id`s already in its transcript and only acts on ids appearing after it,
  so re-opening an old chat from history replays nothing. `ChatMessageBubble`
  renders the record as an "Opened X" link — clickable, never auto-firing.
  The handler hears a live marker twice: from the transcript as it streams
  (so the console moves when the tool answers) and from the turn's finished
  message (`useChatActions().onTurnFinished`), because the transcript is
  throttled and its last batch can land after `status` reads `ready` — read
  from the transcript alone, a marker in that batch would be absorbed as
  history. The handled `nav_id` set keeps the two from navigating twice.
- **`read_page_context`** reports what's on screen, so "summarize this" or "this
  deal" resolves without the user restating it. `PageContextProvider` derives
  the tab and path from the route; a view can enrich it with the record or
  filters in view via `useSetPageDetail` (wired in `Pipeline` and
  `CompanyDetail`). The value reaches `ChatProvider`'s transport body through
  the `src/lib/chat/pageContextStore.ts` singleton — needed because
  `ChatProvider` is mounted at the app root, *above* `PageContextProvider`, so
  React context can't reach it. `/api/chat` sanitizes the payload
  (`sanitizePageContext`: unknown tab dropped, path shape enforced, detail
  clamped — it is browser-supplied and ends up in a prompt) and passes it as
  `configurable.pageContext`, the same seam `thread_id` and `userEmail` use.
  A view with a single deal on screen also publishes that deal's `companies.id`
  via `useSetPageCompanyId` (wired in `CompanyDetail` and `CompanyDetailDialog`).
  It travels as its own `companyId` field rather than inside the `detail` prose,
  must be a well-formed UUID to survive sanitization, and is rendered into the
  tool output as an id to pass verbatim to `company_id`-taking tools — which is
  what stops a near-identical company name from resolving to a sibling record.

## Insights

An **insight** (`/w/<ws>/insight/<id>`) is a document the Copilot writes for
you — a brief, a report, a dashboard-style page — saved as a self-contained
HTML page. Figures are captured when it is written; an insight does not update
itself unless you edit or refresh it.

- **Create and edit from chat.** Ask the Copilot to write or change an insight.
  It shows a preview card first, and nothing is saved until you approve it. An
  edit card shows what changed.
- **Upload an HTML file.** *New insight → Upload HTML file*
  (`/w/<ws>/insight/upload`) saves an HTML file as a new insight without the
  Copilot. You see a sandboxed preview, plus warnings for anything the frame will
  block (scripts off the CDN allowlist, linked images). The file goes as multipart
  form-data to `POST /api/insights/upload` and is stored exactly as uploaded,
  version 1 with trigger `upload`. Insights are capped at 4 MB for every writer.
- **Point at a section.** On an open insight you can select sections and ask the
  Copilot to change just those.
- **Reports.** A report is planned with you before it is written, and must
  follow a fixed structure.
- **Sources.** Figures cite their sources, and a figure that couldn't be found is
  marked *Unavailable* rather than guessed.
- **Version history.** Every change is saved as a new version. You can preview
  any earlier version and roll back to it.
- **List.** The insight list can be searched, filtered by agent or owner,
  archived and restored. One insight per workspace can be featured.
- **Safety.** Insight HTML only ever renders inside a sandboxed iframe
  (`InsightFrame`); never render it anywhere else. `buildInsightSrcDoc` opens
  every document with the host's own doctype and `<head>`, with the CSP first.
  It never searches the author's markup for a `<head>` to inject into, because
  a `<head>` inside a comment or attribute would leave scripts outside the
  policy.

### Insight templates

- Upload an `.html` file (up to 250,000 characters) as a template, or save an
  existing insight as one.
- Attach a template in chat to have the Copilot write an insight in that layout.
  The library shows how many insights came from each template.
- Deleting a template moves it to **Recently deleted**, where it can be restored
  or removed for good.

### Large documents

A chat turn can write roughly 20,000 characters. For anything bigger, the
Copilot offers to hand the job to the **AI Workforce**, which runs it in the
background.

- **Editing a large insight.** Chat edits rewrite the whole document, so in
  chat `get_insight` returns only an outline for an insight over that size,
  with an instruction to hand the edit (insight id plus the selected section
  or element) to the Workforce. The Workforce applies the edit directly as a
  new version; the old version stays restorable from the insight's history.
- **Tier floor.** On Auto, a turn made while an insight is open runs at
  `medium` or above, since the router would read a short edit request as
  `low` and its 90 s budget cannot fit a rewrite. A tier picked by hand is
  never overridden.
- **After a timeout.** Every budget wrap-up offers the Workforce. The next
  turn does not get the whole-document tools (`propose_insight_edit`,
  `replace_insight_document`), and it is told to hand off a document request
  rather than retry it.

### Scheduled refresh

- An insight can be refreshed on a schedule (also listed under AI Workforce →
  Routines), or on demand with **Refresh now**.
- A refresh publishes one new version, only if the run succeeds. If nothing
  changed, the version is marked *No changes* and no email is sent.
- If the agent needs input during a refresh, it asks the insight's owner and
  waits for their answer before publishing.

## Editing company records from chat (`update_company_details`)

Any editable field on a company can be changed by asking the Copilot — its
name, profile (segment, geography, website, ownership, company focus, project
name), deal fields (source, deal type, stake, deal size, banker, banker source,
advisor, doc type, NBO date, live flag, workflow status, key rationale,
comments, remarks, thesis content), and per-year financials (revenue / EBITDA /
EV in USD millions).

The write itself only ever happens in the **Workforce**.
`update_company_details` is registered in `workforceOnlyTools`, so chat cannot
call it: the Copilot resolves the company with `get_company_details`, then
proposes a `propose_workforce_handoff` card carrying an exact field-level
instruction (company id, field, new value). Nothing is mutated until the user
clicks **Assign to Workforce**, and the resulting run's trace records the
before/after — the tool returns each change as `field: old → new`. Once
assigned, the card grows a **View task in AI Workspace** link
(`WorkforceHandoffCard`) that deep-links to `/ai-workforce/tasks/<queueId>` so
the user can watch the run instead of hunting for the row; it falls back to the
queue root when the id isn't a UUID (the route validates it and 404s
otherwise), and clicking it calls `revealConsole()` first, since the copilot
pane may be full-screen over the console. A
`tools/index.test.ts` case pins the tool to the workforce list and out of the
chat/combined/vc lists so it can't drift into an inline write.

Implementation notes (`src/lib/agents/analysis/tools/update_company_details.ts`):

- Core fields go through `CompanyService.updateFromDTO` (log action
  `UPDATED_DETAILS_BY_AI_WORKFORCE`) and yearly figures through
  `CompanyService.updateFinancials` (`UPDATED_FINANCIALS_BY_AI_WORKFORCE`), so
  a detail edit lands on the same normalized write path as the FE company form.
  `FinancialUpsertInput` gained `ev_usd_mn` for this — an omitted key still
  keeps the stored value, which is what the FE editor relies on. Those two
  service calls are two commits, so the error path reports which half landed
  rather than implying a rollback (same shape as `move_stage`'s
  update-then-move into L0).
- **Derived figures are recomputed, not carried over.** `updateFinancials` now
  recalculates `ebitda_margin` and `ev_ebitda` from the merged revenue / EBITDA
  / EV, and nulls them when an input is missing or the denominator is zero.
  Carrying the stored ratio over meant a revenue edit published a margin
  computed against the *old* revenue on the company card and the Excel export.
  Each ratio is gated on **its own** inputs (margin on revenue/EBITDA, multiple
  on EV/EBITDA), not on "any figure changed" — the FE charts PUT a single
  metric, and a revenue-only save must not wipe a multiple that ingest stored
  for a year with no EV on file. `revenue_cagr_vs_prior` is deliberately
  untouched: it spans two fiscal years and belongs to the screening pipeline.
- **Years whose figures already match are skipped**, both in the write and in
  the reported summary, so re-running the same instruction doesn't rewrite rows
  or claim changes that didn't happen.
- **Pipeline state is out of scope, loudly.** `pipeline_stage`, `status` /
  `dropped_*`, `ai_opinion_*` and the user-reference columns are *rejected with
  a pointer to the owning tool* rather than silently stripped — a stage move
  belongs to `lookup_pipeline_stage` + `move_stage` (gated for any move
  touching L1+), a drop to
  `drop_company`, the verdict to `save_ai_opinion`. Silently dropping them
  would let the agent report a change that never happened, and accepting
  `pipeline_stage` would route around the promotion approval gate.
- A rename whose new name already belongs to a **different** company is
  refused, so a rename can't fork one company into two records and break every
  subsequent name lookup. The check is `CompanyRepository.findByExactName` —
  a case-insensitive whole-name match on target / project name / aliases — not
  `findByNameFuzzy`, which strips legal suffixes and substring-matches: the
  fuzzy helper answers "did you mean this company?" and would both refuse an
  innocent "Acme Corp" → "Acme Holdings" (an unrelated "Acme Industries" wins
  the rank) and miss a real duplicate it happened to rank second.
- Dropped companies stay editable (matching `CompanyService`, which blocks only
  lifecycle moves after a drop) — a dropped record can still be corrected.

## Evaluating a company (`financial_equity_analysis`)

`src/lib/agents/analysis/tools/financial_equity_analysis.ts` is a pure,
deterministic calculator — no DB, no network, every figure derived from the
arguments the agent passes it. It runs the seven steps an equity analyst
evaluates a company through, in order:

1. **Revenue growth** — YoY per fiscal year and CAGR across the window.
2. **EBITDA / EBIT growth** — the same, for whichever series is supplied.
3. **Relative position** — peer and market benchmarks split `local` vs
   `global`, with the median margin (NPM, EBITDA), growth and multiple of each
   cohort and the company's gap to it, plus whether the growth is sustained at
   the bottom line (net profit CAGR versus revenue CAGR).
4. **Net profit growth** — with the margin trend behind it.
5. **Valuation** — P/E, EV/EBITDA and P/B off the supplied price, shares, net
   debt and book equity, each placed against the company's **own** historical
   multiple series and reported in standard deviations from its own mean
   (sample stdev; a single observation reports no dispersion rather than a
   fake zero).
6. **Dividend yield** — off DPS and price, falling back to total dividends over
   market cap, plus the payout ratio.
7. **Sum-of-the-parts** — attributable value per segment, holding discount, net
   debt, equity value, value per share and the implied gap to market cap.

It is **fact-only**: no score, no target price, no verdict. Growth off a
non-positive base is `null` ("not meaningful") rather than a nonsense
percentage, and a P/E on negative earnings is refused with a note saying why.

**Missing data is asked for exactly once.** A call carrying no financial
content at all returns `status: "needs_financial_data"` plus `missing_inputs`
and a `request_to_orchestrator` string — the agent goes and gets the figures
(record, files, web/Valyu, or the user) and calls again. The trigger is
deliberately *nothing at all* rather than *not enough*: any call carrying
something — one fiscal year, a price, a peer set — is analyzed, with whatever is
still missing reported under `data_gaps` and `status: "partial"`, so an agent
that comes back with partial figures can never be sent away for them a second
time. `data_request_already_made: true` is the escape hatch for the case where
nothing at all could be found.

Two places register it. The **`minority`** flavor carries it in chat
(`MINORITY_TOOL_LIST` = `defaultChatToolList()` + this tool), because a
non-controlling stake is underwritten on growth, the multiple and the dividend.
The **Workforce** list appends it too (`workforceToolList`), since "Analyze /
Re-evaluate AI Opinion" *is* evaluating a company: the prompt's "Forming an AI
Opinion" steps route that arithmetic through the tool rather than the model's
head, and its output feeds the verdict without voting on it.
