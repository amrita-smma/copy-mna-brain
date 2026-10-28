# Copilot bots (RFC 02)

The in-app Copilot is a set of **bots**. Each bot is a Copilot with its own
name, persona and animated avatar — and **every skill** — and each person has
**one permanent chat per bot**. A new bot is only a name, a shape and a colour;
everything else is set up by chatting with it. There is no New Chat button and no chat history list
— switching bots is how a user moves between conversations. There is no feature
flag: this is the only Copilot flow. (Chats from before bots stay in the
database, untouched, but are no longer shown.)

## Data

| Table / column | Purpose |
|---|---|
| `bots` | `name`, `persona_md` (the owner's text; blank for a new bot), `base_flavor` (a `CopilotAgentType`: the workspace's at creation, not user-settable), `avatar jsonb` (`{hue, eyes, mood, shape}`; users set shape and hue), `visibility` (`private` \| `workspace`), `is_default`, `owner_user_id` (NULL for Brain Bot), `archived_at`. `system_prompt` is deprecated (superseded by `persona_md`) and dropped in a later migration. |
| `copilot_chats.bot_id` | The bot a thread belongs to. A partial unique index on `(user_id, workspace_id, bot_id) WHERE bot_id IS NOT NULL` enforces one thread per user per bot. |
| `copilot_chats.last_message_at` / `last_read_at` | Unread: a reply newer than the user's last read. |
| `copilot_chats.history_imported_at` | Set once the thread's checkpoint history was copied into `copilot_messages`. |
| `copilot_chats.busy_until` | Per-thread turn lock (see *@mentions*). |
| `bot_orders` | Each user's pinned bots, in order, one row per user per workspace (`bot_ids uuid[]`). |
| `copilot_messages` | The chat history as rows: one user row and one assistant row per turn (`parts` for the UI, `text` for search, `embedding vector(1024)`, generated `search tsvector`, `seq` for paging). |
| `routines.bot_id` | Set for a bot's routine (see *Routines*); NULL for AI Workforce routines. |
| `bot_requests` | A request one bot made to another by @mention: `group_id` (the asking turn), `from_bot_id`/`from_chat_id`, `to_bot_id`, `ask`, `answer`, `status` (`pending` \| `done` \| `failed` \| `timed_out`). See *Reply-back*. |
| `bot_user_memories` | What one bot remembers about one user: `notes jsonb` (`[{text, created_at}]`), unique on `(bot_id, user_id)`. See *Memory* under *Creating a bot*. |
| `bot_task_logs` | Each bot's task log: one summary line per task, with `source` (`chat` \| `mention` \| `routine`), the user it was done for, and the routine if any. |

## Brain Bot

Every account has a **primary bot** (called Brain Bot in the code). Each user
sees it named after them: their first name's bot, e.g. "Nico's bot"
(`primaryBotName`: the first word of their name, else of their email, else
"My bot"). It is the workspace's one
`is_default` row (on the workspace's flavor). The migrations backfill it for
existing workspaces, and `BotService.list` / `openDefaultThread` create it on
first use for new ones. A chat turn that names no bot runs on it.

- **Fixed.** `presentBotRow` (`botService.ts`) always gives it the user's
  name for it (`BotService` reads the user once per request, only when the
  primary bot is in the rows; the stored row name is unused), its own persona
  (`BRAIN_BOT_PERSONA`: the master agent, which hands work on by @mention) and
  the black **Apex** body (`BRAIN_BOT_AVATAR`), whatever its row holds. Nobody
  can edit or archive it (`canEditBot` is false). No other bot may wear Apex.
- **Starred.** An amber star (`PrimaryStar`) sits on its avatar in every bot
  list: the sidebar, the Copilot strip and All bots menu, the collapsed rail,
  the Bots page and the mobile home.
- **Not shared.** Every member reaches it, but each has their own thread, and
  its **routines and task log are each person's own**: `BotRoutineService`
  scopes its routines to `created_by = me` (anyone may add one), and the task
  log reads only the user's rows (`ownOnly`). No shared-routine warning shows.
- **Always first.** It leads every bot list ahead of the pins, and is never
  pinned, unpinned or dragged (`sortBots`, `useBotPinning`; `setPinned`
  drops its id). The Copilot strip and the All bots menu show it outside the
  reorderable list.
- On the Bots page it leads the **Private** section (it is each person's own);
  its card opens a
  read-only **About** tab (with Routines and Task log) instead of Settings.

## Permissions

- Any member can create a bot. It starts private; its owner can share it with
  the workspace from its settings.
- A private bot is its owner's alone. **Anyone in the workspace can edit a
  shared bot**, including its routines (`canEditBot`). Nobody edits Brain Bot.
- Only the owner archives a bot or changes who sees it. Brain Bot can be
  neither archived nor changed. Editing a bot you don't own shows a "your
  changes apply for everyone" notice.
- A private bot owned by someone else returns 404, never 403.
- Tools always run as the person chatting (`configurable.userId`). A bot's
  persona never changes whose data a tool reads, and a bot tool can only change
  a bot's persona, name, look or sharing when the chatting user could change
  them by hand.
- A bot's **memory of a user** is that user's own, not a change to the bot:
  anyone who can see a bot keeps their own notes on it, including on a shared
  bot and on Brain Bot, and nobody else reads them.

## Creating a bot, and setting it up in the chat

- **Create** (`BotEditDialog`, or `propose_create_bot` on a card): a name, a
  shape and a colour. Eyes and mood are picked at random. The bot is private,
  runs on the workspace's flavor and has every skill. From the dialog it
  starts with a **blank persona**; the tool may also propose a **persona** and
  up to five **routines** it starts with, which the card shows (persona in a
  block, each routine with its schedule in words) and creates with the bot on
  approval — the bot first, then each routine through the routines API, with a
  failed routine reported on the card while the bot stands.
- **Greeting.** `BotService.create` calls the `greet` dep (wired in
  `container.ts`) for a bot with a blank persona: it seeds an assistant
  message, `botGreeting(name)` — "Hi there! I'm <name>. Tell me who I am and
  what I do!" — into the creator's thread checkpoint, which the history
  imports on first read, and stamps the thread unread. A failed greeting is
  logged; the bot stands. The Bots page opens the new bot's chat.
- **The persona** (`persona_md`, `src/lib/bots/persona.ts`) is the bot's
  system prompt as far as its owner can change it: free markdown. It is set by
  telling the bot (`update_bot` on itself) or in the **System prompt** editor
  on the bot's Settings tab, which also has the name, shape, colour and the
  share toggle (owner only). `personaText` drops the managed block personas
  carried before. **No approval card for a persona change on a private bot**:
  the tool writes it at once. On a **shared** bot the same change goes on a
  card with a warning ("… is shared with the workspace: this changes it for
  everyone who uses it (persona), not just for you …") and a *Confirm change*
  button, because it changes the bot for the whole workspace. A **name or
  look** change follows the same rule: at once on a private bot, on the
  warning card on a shared one. **Sharing or unsharing** always goes on the
  card, since everyone gains or loses the bot; sharing a private bot gets its
  own wording ("… will be shared with the workspace: everyone gets it as it is
  below …"), because the bot is not shared yet.
- **Memory** (`bot_user_memories`, `src/lib/bots/memoryTypes.ts`,
  `BotMemoryService`) is what one bot remembers about **one user**: the notes
  that user asked it to keep — preferences and standing requests ("remind me
  about stalled deals on Fridays", "answer in Bahasa", "I cover coal") — as a
  jsonb array, one row per user per bot, capped at 50 notes of 300 characters.
  The bot saves them with `update_bot` (`remember` / `forget`) the moment the
  user asks, with no card: they are the user's own, on any bot the user can
  see (a shared bot included, Brain Bot included), and never change the bot
  for anyone else. Every turn with that bot — the chat route and a background
  turn alike — carries the user's notes as a system-context block after the
  mem0 recall (`BotMemoryService.promptContext`; not behind the mem0 switch,
  since these are explicit requests). The **Memory** tab of the bot dialog
  lists them with a delete each and a box to add one (`GET`/`PUT
  /api/bots/:id/memory`). The fixed instructions tell every bot the two
  apart: *persona* is how it behaves for everyone; *memory* is what is
  particular to this person.

## The fixed system prompt

`assembleBotSystemPrompt` (`src/lib/bots/prompt.ts`) is the same for every
bot except the last section: guardrails → flavor prompt → `BOT_REPLY_STYLE` →
`BOT_FIXED_INSTRUCTIONS` → who the bot is.

- `BOT_FIXED_INSTRUCTIONS` (nobody can change it): how to use every skill
  (`BOT_SKILL_META[k].guide`, all of them) and the hand-off rule — **call
  `lookup_bot` before every hand-off** to pick the bot whose persona fits, then
  @mention it by exact name.
- **Who you are**: the bot's name, then its persona in `<bot_persona>`. With a
  blank persona it is told it asked the user who it is, to help meanwhile, and
  to save their answer as its persona with `update_bot` on itself.
- **Persona or memory**: a section of `BOT_FIXED_INSTRUCTIONS` that tells
  every bot apart a persona change (everyone; `update_bot persona`, confirmed
  on a card for a shared bot, as are its name and look, with sharing always
  on the card) from a note to remember (this user; `update_bot remember`),
  with examples of each, and to save either the moment the user asks.

## A chat turn (`POST /api/chat`)

The route reads top to bottom as the turn's stages; the pure parts live in
`src/lib/chat/`: `readTurnRequest` (`turnRequest.ts`) reads the body once,
with no I/O, `buildTurnMessage` (`turnMessage.ts`) assembles the human
message from the attachments, template and selection, and `finishTurn`
(`finishTurn.ts`) is the `after()` hook of step 5.

1. `BotService.openThread` (or `openDefaultThread` when no `bot_id` is sent)
   resolves the visible bot and the user's thread with it. The user's name
   (which titles their primary bot) and the thread are read together; the
   thread is created only when the find comes back empty. The bot list for
   the @mention note (`prepareMentionContext`) is started before the open
   and read behind it.
2. `CopilotChatsService.claimTurn` takes the thread's turn lock, in the same
   round trip as the per-bot context reads; while another bot's message is
   being answered on it, the route returns **409**. A path that ends between
   the claim and the `after()` hook that normally releases it — attachments
   refused, no agent, a throw — gives the lock back itself (`abandonTurn`).
3. The graph is the bot's **base flavor's** cached chat graph; the graph cache
   is never keyed by bot. `buildBotTurnOverride` swaps in this turn's prompt,
   tools and middleware:
   - **Prompt** (`assembleBotSystemPrompt`, see *The fixed system prompt*).
     Per-turn context comes last.
   - **Tools**: the flavor's tools, `search_chat_history` and `offer_options`,
     then every skill's tools not already there (`mergeBotTools`).
   - **Middleware**: `summarizationMiddleware` (past 60k tokens, keeps the last
     20 messages). That in-line trigger is the safety net: after a turn, once
     the thread passes 48k tokens (`BOT_SUMMARY_AHEAD_TOKENS`), the same
     summarizer runs in the `after()` hook instead (`summarizeThreadAhead`,
     `src/lib/bots/summarizeAhead.ts`; background bot turns do the same from
     their job) — the summary is computed off the lock from the thread as the
     hook read it, then written under the lock only if the checkpoint has not
     moved (`AgentGraph.replaceMessagesIfAt`), so the summary call is never
     paid before a turn's first model call. Context editing is **off** for
     chat: clearing tool results rewrites the history and invalidates the
     cached prompt prefix.
   The compiled agent for a bot's prompt + tools is memoised on the flavor
   graph (`AgentGraph.getAgent`), so a turn does not rebuild it.
4. The effort tier is chosen **per turn**; nothing is stored on the thread.
   The tier also fixes the model's `thinking` setting (`EFFORT_TIERS[tier].thinking`
   in `src/lib/agents/analysis/effort.ts`): the two Sonnet tiers run with **no
   up-front thinking** (`between_tools` — the first tool call or the answer
   starts at once and reasoning happens between tool calls), the Opus tiers
   with adaptive thinking and its summary shown. Measured on the real chat
   prompt with stubbed tools, first visible text fell from a median ~10 s to
   ~1.5 s on `low` and ~7 s to ~1.7 s on `medium`, whole turns by 20–35%,
   with tool choice and answers unchanged. The trade is the reasoning panel:
   `between_tools` takes no `display` field, so there are no thinking
   summaries to stream on those tiers; the model's own first sentence is the
   progress the user sees.
   The router (`routeEffort`) is a Haiku call with thinking off, capped at
   `ROUTER_TIMEOUT_MS` (1.5 s), started as soon as the turn's text is known
   so it overlaps the thread open and the context reads. A turn it cannot
   place runs at `low` when short and attachment-free, `medium` otherwise
   (`fallbackEffort`). A *very* short attachment-free turn — at most
   `ROUTER_SKIP_CHARS` (60) characters: a greeting, a "continue", one
   lookup — is not routed at all and runs at `low` (`shouldRoute`), so the
   router is off that turn's critical path; the open-insight floor and a
   hand-picked tier are unaffected. The thread's persisted history is read through
   `readThreadSnapshot` (`src/lib/agents/analysis/graphs.ts` — whichever
   Copilot flavor graph the process has built, or the default one; every
   chat graph shares the checkpointer and carries no middleware, so a sector
   thread reads the same through it) as soon as the turn lock is held, so
   that read rides behind the router and the attachment upload instead of
   waiting for the tier's graph.
   The per-turn context also names the other bots it can
   **@mention** (`mentionableBotsContext`, sorted by name so the note is
   byte-identical between turns).

   **Prompt caching.** The fixed system prompt is one content block carrying
   a `cache_control` breakpoint; everything that changes per turn (workspace
   context, recalled memories, the open insight's outline, this note) is
   appended as a *separate* block at model-call time
   (`perTurnContextMiddleware`, from `configurable.additionalSystemContext`).
   Tools + fixed prompt are therefore read from cache on every call after
   the first, whatever the per-turn block says. `AgentGraph.wrapEventStream`
   logs `cache_read` / `cache_write` per model call; the route logs a
   per-stage timeline of the setup path (`TurnTimer`).
5. The question is stored in `copilot_messages` as soon as the turn lock is
   held (`ChatHistoryService.persistQuestion`), so a tab reloaded mid-turn
   shows it under the live bubble rather than an empty thread. The route
   picks the row's id itself and does not wait for the insert: the run, its
   Langfuse trace and the reply's feedback key all use that id while the
   write is in flight alongside the stream start. After the
   response (`after()`, the body of which is `finishTurn` in
   `src/lib/chat/finishTurn.ts`): the insert is awaited, the reply is stored
   (`persistTurn` with `questionStored`, marked read; when the up-front
   write failed the question is stored here under the same id, so the id
   the reply was given never dangles; a turn that never reached the thread
   discards its question row instead), an embedding job is queued,
   the reply's @mentions are handed on (`BotService.dispatchMentions`; the
   user's own @mentions went out when the message arrived), the turn
   is queued for the task log and mem0 memory is updated. The turn lock is
   released right after the reply is stored — before the hand-off, the task
   log and the memory write-back, none of which touch the thread — so a quick
   follow-up message is not refused with a 409 while an LLM extraction runs.
   All of it waits for the turn to finish, not for the browser.

### A turn outlives the browser

Leaving a chat mid-reply (switching bots, closing the tab, a dropped
connection) does not stop the turn:

- **Server.** The agent's signal is the turn budget plus an explicit Stop, not
  the request's signal. `createUIMessageStreamResponse`'s `consumeSseStream`
  reads a tee'd copy of the stream to the end on the server, so the agent keeps
  running when the client's copy is cancelled, and every `after()` job (storing
  the turn, Anthropic upload cleanup, the Langfuse flush, releasing the lock)
  first awaits that drain.
- **Stop.** The stop button calls `POST /api/copilot/chats/:id/stop`
  (`CopilotChatsService.requestStop`): while the lock is held it sets the
  Redis flag `chat:stop:{chatId}` (`requestStopSignal`), which the running
  turn polls every second (`watchStop`) and aborts on — interactive and
  background turns alike. Replacing a running turn ("analyze with AI"
  mid-reply) stops it the same way and waits until a repeat Stop reports
  `stopped: false` (the lock is free) before sending.
- **Client.** Leaving a live thread only aborts the fetch. The question is kept
  in memory by thread and shown on return under the thinking bubble, which
  shows while the bot's live presence (below) says it is running and this
  tab is not streaming it. When the stream announces the stored reply
  (`reply`), the thread's latest page is laid over the one on screen: the
  kept question matches its stored row by text and keeps its bubble, the
  reply is appended. After a full page reload the kept question is gone, so
  only the bubble shows until the reply lands. No partial reply is replayed:
  the stream is not recorded.

## History, search and compaction

- **Paging, by turns.** `GET /api/copilot/chats/:id/messages?before=<cursor>&turns=`
  returns `{messages, nextCursor}` from `copilot_messages`, oldest first: the
  last `turns` turns before the cursor (`CopilotMessageRepository.listTurnsPage`;
  a turn runs from a user row to the next, so a page never splits one).
  Opening a bot loads its last 5 (`CHAT_HISTORY_PAGE_TURNS`). Scrolling near
  the top loads the 10 before them (`LoadEarlierMessages`, an
  IntersectionObserver sentinel at the top of the transcript), keeping the
  scroll position; a page that leaves the top in view loads the next one too.
  A thread from before the table is imported once from its checkpoint, on its
  first read or write. A turn writes its user row when it starts and its
  assistant row when it ends (background turns too: the target bot's chat
  shows the asking bot's message under the thinking bubble while it works).
- **Search.** `search_chat_history` (every bot has it) runs a hybrid search over
  the user's stored exchanges — pgvector nearest neighbours plus full text,
  merged by reciprocal-rank fusion (`CopilotMessageRepository.hybridSearch`).
  It is scoped to the chatting user, and to the current bot unless asked for
  `all_bots`. Embeddings come from the `chat_message_embedding` job (Bedrock
  Titan v2); an exchange without one is still found by full text — but only
  when every word of the question appears in it, so the dispatch cron
  backfills: each tick `sweepUnembeddedChatMessages` queues the embedding of
  up to 40 stored exchanges that have none (a job that failed, or a fresh
  database where the job type was missing before the migrate repair).
- **Checkpoint compaction.** `/api/cron/compact-checkpoints` (hourly) keeps the
  two newest LangGraph checkpoints of each Copilot thread idle for 15+ minutes
  and deletes the rest, their pending writes, and every blob no remaining
  checkpoint references (`CheckpointCompactionService`). The newest checkpoint
  holds the full live state, and the UI history lives in `copilot_messages`,
  so nothing visible is lost. Workforce threads are never compacted.

## Skills

`src/lib/bots/skills.ts` maps each skill to its tools; labels, descriptions and
guides are in `BOT_SKILL_META` (`src/lib/bots/types.ts`, client-safe). **Every
bot has every skill**: nothing is stored or picked (the `skills` column is
gone), so a skill added later reaches every bot.

| Skill | Tools |
|---|---|
| `crm`, `pipeline`, `insights`, `research`, `relationships`, `email` | existing chat tools |
| `bot_builder` | `lookup_bot`, `propose_create_bot`, `update_bot` |
| `routines` | `list_routines`, `propose_create_routine` (a card), `update_routine`, `delete_routine` (applied at once) |
| `tasks` | `list_tasks`, `create_task`, `update_task`, `delete_task` — the user's personal to-dos, full CRUD applied at once (no card, no Workforce); see [`personal-tasks.md`](personal-tasks.md) |
| *(every bot)* | `search_chat_history`, `offer_options` |

**Bot builder.** `propose_create_bot` / `update_bot` validate the
change (`BotService.previewCreate` / `previewUpdate`, which also refuses a bot
the user cannot edit) and — for a create, or any change to a bot that is
shared on either side of it — render a `BotChangeApprovalCard` in the transcript:
a compact record of the bot — avatar, name and a status pill (Proposed →
Created / Updated / Cancelled), one line on its look and routines (or, for an
update, on what changes), the persona folded to two lines behind "Show full
persona", and the routines it starts with — then Cancel / Create (or Apply).
Nothing on the card is editable: a bot is edited in its own chat or on the
Bots page. Nothing is written until the user approves; the card then calls
the bots API, which checks permissions again. Colours are words (`blue`, `purple`, …) or hues.
`propose_create_bot` takes a name, colour and shape, and optionally a persona
and the routines the bot starts with (validated by
`BotRoutineService.validateInput`, scheduled by the card after the bot exists).
`update_bot` (bot optional: itself by default) does two different things it
keeps apart: the **bot** — persona (`persona` / `persona_append`), name,
look and sharing — written at once through `BotService.update` on a private
bot, and put on a card with a `warning` naming what changes and a *Confirm
change* button when the bot is shared, becomes shared, or stops being shared
with this call — and the user's
**memory** on the bot (`remember` / `forget`, up to 10 notes a call; written
at once through `BotMemoryService`, the user's own on any bot they can see,
reported back in the tool's text with no card). A call may do both; the
memory part never waits on the card. Cards from the tool's former name,
`propose_update_bot`, still render from stored history.

**`lookup_bot`** lists the bots the user can see with what each does (its
persona, flattened and clipped), whether it is shared and whether the user can
edit it; a `query` ranks the bots whose name or persona fits first.

## @mentions

Bots hand each other work by **@mention** — there is no messaging skill.

### Reply-back: the asked bot always answers the asker

When bot A's reply @mentions bot B, B's answer no longer stays in the
user↔B chat alone — A hears back and closes the loop with the user:

1. `dispatchMentions` (the chat route's `after()`, or a routine turn) opens a
   `bot_requests` row per mentioned bot (`BotRequestService.open`), all with
   `group_id` = A's turn id, `ask` = A's reply clipped to 600 chars (a
   reminder for the reply-turn header only — B is sent the whole reply), and
   stamps `requestId` on each `bot_mention` message. A shows nothing special
   while it waits — no thinking icon; its thread is free.
2. B's run (`runBotMessage`, in its own Workflow step — see *A background
   turn is a Workflow run* below) answers in the user↔B thread as before —
   its `originContext` now says the answer is passed back to A — and closes
   the request either way: the answer, or the failure (`BotThreadBusyError`,
   an agent error, a step cut off by the platform) as the note.
3. `BotRequestRepository.close` runs under the group's advisory lock
   (`pg_advisory_xact_lock(hashtext(group_id))`) and is idempotent (only a
   `pending` row closes; `runJob`'s timeout can mark a job timed out while
   its work still finishes, and a redelivered step may close it a second
   time). The close that leaves no sibling pending returns the whole group,
   and the service starts **one** `bot_reply` run for A with every answer —
   fan-in, so A answers the user once and takes its thread's lock once.
4. A's `bot_reply` turn (`runBotTurn`, origin `{kind:'bot_reply', replies}`)
   runs in A's thread: the message lists each bot's answer under what A asked
   it, the context tells A to write the answer for the user, crediting each
   bot, and never to @mention them about it again (A→B→A, then stop). It is
   stored like any background turn: a user row with `author_bot_id` = the
   first answering bot and `from_bot.kind = 'bot_reply'`, with every other
   answering bot in `from_bot.others` ("Reply from B and 1 other", both
   avatars, in the transcript), then A's assistant row, unread. In the transcript, other
   bots' messages — replies back and hand-offs — are **collapsed by default**
   (A relays what matters in its own answer, so open they would repeat it),
   and a run of them folds into one row with the senders' avatars side by
   side and a label naming the first and counting the rest, such as
   "Reply from Deal Scout and 2 others"
   (`groupRelayMessages` in `src/lib/chat/relayGroups.ts`, rendered by
   `BotRelayGroup`); a click opens the messages.
5. Safety net only: the dispatch cron (`/api/cron/dispatch`, every minute)
   calls `sweepBotRequests`: requests still `pending` after
   `BOT_REQUEST_TIMEOUT_SECONDS` (660 s: the turn's `runJob` budget plus a
   minute) are closed as `timed_out` ("did not answer in time") through the
   same group-close, so A still gets its reply turn. Nothing is re-sent. A
   run that dies mid-step normally closes its own request on the retry (see
   below), so the sweep only catches a run that never started.

### A background turn is a Workflow run

Every background turn — `bot_message` (an @mention), `bot_reply` (the fan-in
answer), `bot_routine` (a routine firing) — is a **Vercel Workflow run**
(`src/lib/bots/botMessageRun.ts` → `botMessageWorkflow` → the one step
`runBotMessageStep`), never `after()` work inside the invocation that
dispatched it. The old path nested A → B → A inside the chat route's 600 s
invocation and froze on Vercel with the job `running`, the request `pending`
and B's lock held; previews, which have no cron, never recovered.

- **The message is an API request.** `dispatchBotMessage` (`container.ts`) →
  `sendBotMessage` (`src/lib/bots/botMessageClient.ts`) POSTs
  `{ workspaceId, userId, toBotId, text, origin, requestId? }` — which user,
  which bot, which text, the request it answers — to our own
  `POST /api/internal/bot-messages` (`src/app/api/internal/bot-messages/route.ts`).
  That route, in its own invocation, inserts the `jobs` row (the audit trail,
  as for every async job), calls `start(botMessageWorkflow, …)` and appends a
  `job_logs` entry naming the hand-off, so every bot-to-bot message is a
  logged request plus an audit row whoever sent it (the chat route's
  `after()`, the cron tick, another bot's running turn). The caller carries
  nothing and never retries (a retry could run a turn twice); a failure is
  logged per target, and a routine reverts its schedule advance.
- **A start that fails is reported, never killed.** The route reads the turn
  budget from `src/lib/bots/botMessageTimeout.ts` (not the handler, whose
  imports are the whole agent runtime — on a cold start that import alone
  used up the route's 30 s). `start()` is bounded by `START_RUN_TIMEOUT_MS`
  (15 s): past it the job row is failed with the reason and the sender gets a
  504 (`Timed out starting the turn`); a `start()` that throws gets a 500.
  Either way, when the message was answering a request (a `bot_mention`), the
  route closes it with "the turn never started", so the asker's reply turn
  runs now rather than after the 660 s sweep. The sender waits
  `SEND_BOT_MESSAGE_TIMEOUT_MS` (30 s), longer than the route's deadline, so
  it hears the route's reason rather than its own abort. A run that `start()`
  does create after the deadline is harmless: its step finds the row failed,
  not pending, and leaves it alone.
- **Calling ourselves.** `src/lib/server/internalApi.ts`: the URL is
  `INTERNAL_API_URL`, else on Vercel the production domain
  (`VERCEL_PROJECT_PRODUCTION_URL`) or the deployment URL (`VERCEL_URL`),
  else `APP_URL` / `NEXT_PUBLIC_APP_URL` / `NEXTAUTH_URL` / localhost (inside
  the docker `app` container localhost is the app). The call carries
  `X-Api-Secret: $ADMIN_SECRET`, the repo's machine-to-machine credential —
  the same way the data pipeline calls the smart-files route; `src/proxy.ts`
  gates `/api/internal/` on it (the `secret` class) and the handler checks it
  again, failing closed without it. A preview URL sits behind Deployment Protection, so the
  call carries `x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET`
  when that variable exists — enable **Protection Bypass for Automation** once
  on the Vercel project and Vercel exposes it.
- **The step** runs in its own function invocation with WDK's `maxDuration`
  (`'max'`). It claims the row atomically (`JobRepository.claimPending`,
  pending → running) and runs `runJob(… runBotMessage(…))`, which records
  `completed` / `failed` / `timed_out` exactly as before. The called bot's live
  state (presence, Stop, the reply push) goes through Redis from inside the
  step, unchanged.
- **Redelivery.** WDK retries a step whose invocation died (`maxRetries = 1`),
  and a delivery can be duplicated. Every write is conditional: a first
  delivery that cannot claim the row leaves it alone (a live attempt owns it);
  a retry (`getStepMetadata().attempt > 1`) fails the row only if it is still
  `running` (`failIfRunning`) and then closes the request with that note (A
  still hears back; the turn is **not** re-run — a second reply would be a
  duplicate); a row that finished after all is left as it is.
- **If `start()` throws** (no workflow world, a discovery miss), the row is
  marked `failed` and the error reaches the caller: `dispatchMentions` logs it
  per target, `BotRoutineService.fire` reverts the schedule advance.
- **Locally** WDK's Local World runs under `next dev` with nothing to
  configure (runs in `.workflow-data/`, steps posted back to the dev server;
  `npx workflow inspect runs` lists them). Its queue is in-memory: a dev-server
  restart mid-turn loses the step, the job stays `running`, and the asker is
  healed by the request sweep when `/api/cron/dispatch` is next hit by hand.
  If steps never arrive inside the docker stack, set
  `WORKFLOW_LOCAL_BASE_URL=http://localhost:3000` in `.env.local`.
- The task-log summary (`bot_task_summary`) is still a `dispatchJob` /
  `after()` job, queued from inside the step: that works because WDK runs the
  step body inside the `.well-known/workflow/v1/step` route's request scope.

`user_mention` (the user typed @B inside A's chat) opens no request: the user
asked, and B answers them in its own chat.
`src/lib/bots/mentions.ts` matches `@Name` against the user's visible bots
(case-insensitive, longest name first, word boundary after, never the bot
itself; a bot's reply pings at most 3, a user's message every bot it names);
the composer, the transcript and the server use the same rule.

- **The user** types `@` in the composer: a popup (`BotMentionPopup`) lists the
  other bots; picking one writes `@Name`. A user's @mention **always pings**:
  `/api/chat` queues it as soon as the message arrives (once the turn lock is
  claimed), before the active bot answers, so it goes out even when that turn
  fails or is stopped. The active bot answers as usual *and* each mentioned bot
  gets the message.
- **A bot** writes `@Name` in its reply: the mentioned bot gets the reply.
- **Nothing handed on is clipped.** The message a mentioned bot receives and
  the answer relayed back to the asker are passed whole, however long — bots
  hand each other full research reports. Only the "you asked: «…»" reminder
  (600 chars) and a failure note (500) are short by design.
- `BotService.dispatchMentions` starts one `bot_message` Workflow run per
  mentioned bot (the user's mentions on arrival, the reply's after the turn —
  a bot the user already pinged is not pinged again by the reply) →
  `runBotMessage` / `runBotTurn` (`src/lib/bots/runBotTurn.ts`).
  The bot answers **in the user's own thread with it**, as the user, in the
  background, and the reply is stored **unread** (a dot). The message is
  labelled in that thread: "You mentioned this bot in your chat with X" or
  "X mentioned this bot" (`from_bot` kwarg, with `kind`).
- A message or reply with mentions shows a **Pinged** footer (`MentionPings`):
  a chip per bot that opens its chat.
- **One hop.** A reply to a mention never pings anyone. A routine's reply may,
  since a routine speaks for the user.
- A background turn cannot use `send_email`, `navigate_page`,
  `read_page_context` or `propose_create_routine`. It waits up to 60s for the
  thread's turn lock, then fails its job (and closes its request with that
  failure); while it holds the lock, an interactive turn on that thread gets
  a 409.
- Before it runs, a background turn repairs its thread the way the chat
  route does before every turn (`runBotTurn`): stale `file` blocks are
  neutralized, and a tool call a cut-off turn left without its result is
  closed — a client tool_call gets a cancelled ToolMessage, a server tool
  (`web_search`, `code_execution`) without its `*_tool_result` block is
  stripped (`repairCorruptServerToolCalls.ts`), since Anthropic rejects the
  whole turn otherwise (`400 … found without a corresponding
  web_search_tool_result block`). A repair that fails is logged and the turn
  still runs.
- History from before mentions may still hold `message_bot` tool calls; their
  `BotMessageCard` still renders.

## Routines

A bot's routine is a message it is sent on a schedule, **as the routine's
creator**, in the creator's own chat with the bot — as if they had typed it.
Stored in `routines` with `bot_id` (workforce routine lists and routes ignore
these rows), scheduled with the workforce routines' `normalizeSchedule` /
`computeNextFireAt` (daily, weekly, monthly, cron; per-routine timezone).

- **Firing.** The per-minute `/api/cron/dispatch` tick (`fireDueRoutines`)
  hands a bot routine to `BotRoutineService.fire`. It advances the schedule
  only if still due (`advanceIfDue`, so two ticks cannot both fire), then
  starts a `bot_routine` Workflow run (its own invocation, not the cron's 60 s
  one): the prompt as a `HumanMessage` tagged `from_routine`, shown as
  "Routine · title". The routine **pauses** instead
  when its bot is archived, its creator can no longer see the bot, or the
  creator left the workspace.
- **Sharing.** Whoever may edit the bot manages its routines, so a **shared
  bot's routines are shared**: everyone sees them and anyone can edit or
  delete them, while each still runs as its creator. The Routines tab and the
  approval card both warn about this. Brain Bot is the exception: each
  person sees and manages only their own routines on it.
- **Skill.** `routines` gives `list_routines`, `propose_create_routine`,
  `update_routine` and `delete_routine`. The proposal renders a
  `BotRoutineApprovalCard` (title, schedule in words, the message, the shared
  warning); nothing is scheduled until the user clicks Schedule, which calls
  the routines API as them. A routine with no timezone takes the approver's
  browser timezone. Changing or deleting an existing routine **applies at
  once, no card**, through `BotRoutineService.update` / `archive` with the
  same permission check as the API (whoever may edit the bot; own routines
  only on Brain Bot). `update_routine` takes only what changes — a new time
  is laid over the routine's own weekdays and timezone, and switching between
  daily, weekly and monthly keeps the hour; a cron expression alone switches
  the routine to cron, and a detail the resulting kind would ignore (weekdays
  on a daily routine, a time on a cron one) is refused rather than dropped
  (`schedulePatch` in `tools/routineRef.ts`). A routine is named by id or
  title, and an ambiguous phrase is refused. When the routine is someone else's on a shared bot, the
  tool result says so, since it keeps running as its creator. A background
  turn (a routine firing, a mention from another bot) may pause or change a
  routine but never delete one: `delete_routine` is in
  `BACKGROUND_WITHHELD_TOOLS`.
- **API.** `GET/POST /api/bots/:id/routines`,
  `PATCH/DELETE /api/bots/:id/routines/:routineId`,
  `POST /api/bots/:id/routines/:routineId/run` (runs now, as the caller,
  without moving the schedule).

## Task log

Every finished bot turn — a chat, an @mention, a routine run — is queued for a
one-line summary (`BotTaskLogService.record` → `bot_task_summary` job →
`summarizeBotTask`, Haiku). Small talk summarizes to `SKIP` and is not logged.
`GET /api/bots/:id/tasks?before=&limit=` pages the log newest first. A user
sees the tasks done for them plus **every routine run** on the bot; other
people's chats stay private.

## Replies: verdict first, dated citations, option cards

Every bot's prompt carries `BOT_REPLY_STYLE` (`src/lib/bots/prompt.ts`), after
the flavor prompt and before the persona; a persona can change tone, not this
shape.

- **Verdict first.** The answer (a call in bold: **Pursue**, **Pass**, **Yes**,
  **Unclear**) opens the reply; the supporting detail follows, most decisive
  first. Replies are concise.
- **Research is unchanged.** The flavor's own search instructions still
  apply in full; brevity changes the writing, not the checking, and thin
  evidence gives an **Unclear** verdict.
- **Next action as a plain question.** The flavor's "Offer the Next Action"
  close (one specific question offering an action the bot can take) stays a
  plain question, not an `offer_options` card.
- **Inline dated citations (MB-695).** Each sentence or bullet built on an
  external fact ends with `([Source, 12 Mar 2026](url "Headline"))`, or
  "undated"; several sources for one point share a parenthesis, split by
  semicolons. With `MarkdownRenderer` `citationPills`, the remark plugin
  `remarkCitationGroups` (`src/lib/chat/citations.ts`) folds each run of
  adjacent citation links — and the parentheses that only wrapped them — into
  one `<cite>`, which `CitationGroup` draws as a chip beside the statement
  (first source's initial and name, "+N" for the rest). Hovering it with a
  mouse, or tapping/pressing it, opens a card listing each source's
  publisher, headline (the link title; the URL's host for older replies that
  have none) and date, each linking out. Citations separated by prose stay
  separate chips; they are not moved to the paragraph's end. A source older
  than `STALE_SOURCE_MONTHS` turns the chip amber and is marked "dated" in the
  card — computed from the date, not trusted from the text.
  The renderer tolerates the shapes models drift into: an inline HTML
  `<a href="https://…">claim</a>` is rewritten to a markdown link before
  parsing (`htmlAnchorsToMarkdown`; react-markdown would print the tags), a date at the end of a phrase ("profile updated May 2026")
  still dates the citation, and a claim wrapped into the link
  (`[Claim (Source, date)](url)`) splits into the claim and a chip. The prompt
  also forbids all three.
- **Sources and Files strip.** Under the answer, "Sources" lists the answer's
  own inline citations first (`inlineCitationsOf`) — Anthropic's `web_search`
  results never reach the transcript, so these are the only record of what it
  read — then the Valyu results it did not cite; "Files" lists the files it
  read, with `FileKindIcon`. Outlined, opaque chips truncated to one line, full
  headline and date in the tooltip, amber when dated.
  Valyu results also carry `published` into the "Sources" chips, which show
  and flag the date the same way. **The threshold is pending Nur**; 12 months
  is a placeholder (changing it re-pins `prompt.test.ts`).
- **Option cards.** `offer_options` (every bot, interactive turns only) shows a
  card instead of choices in prose: `single` (sends on click), `multi` (tick,
  then Send), and a custom free-text answer unless `allow_custom: false`. 2–6
  options, at most one recommended (`src/lib/chat/optionCards.ts`). The pick
  is sent as the user's next message (`optionAnswerText`), and the card then
  shows what was chosen, stored with the chat like every action card's
  decision ([Copilot action cards](copilot-action-cards.md)).
- Inline charts are not part of this (parked, MB-787).

## Unread dots

`BotRepository.listVisible` joins each bot to the user's thread with it and
returns `unread = last_message_at > last_read_at` (one query). The client polls
the bot list every 30s while the tab is visible (and when it becomes visible),
and after every turn. A dot shows on the avatar in the bot strip, the sidebar
and the collapsed rail; never on the active bot. Opening a bot marks it read
(`POST /api/bots/:id/read`); a background reply into the bot on screen is
merged into its transcript in place (`mergeLatestHistory`, below).

## Live presence (Redis) and the events stream

What a bot is doing right now lives in Redis, not Postgres, and reaches the
browser pushed, not polled. Redis is **required infrastructure**
(`terraform/redis`; locally `pnpm docker:run-redis` and `REDIS_URL`; in a
deployment also `REDIS_CA_PEM`, the pinned CA as PEM or base64 — use base64
in the Vercel dashboard, which may not keep a multiline value intact); without
it the page still renders from Postgres on refresh, but nothing updates live.
`src/lib/server/redis.ts` holds the client; `src/lib/bots/presence.ts` is the
one writer every path goes through:

| Key / channel | Holds |
|---|---|
| `bot:presence:{chatId}` | The running turn: `{botId, phase, turnId, since}`, EX 30 s, re-set every 10 s by the turn. A crashed turn's marker expires on its own — the Postgres lock's 10-minute TTL no longer decides what the icons show. |
| `chat:stop:{chatId}` | Stop was pressed on the running turn (EX 900; cleared when the next turn starts). |
| `ws:{workspaceId}:user:{userId}` | Events for that user: `presence`, `reply`, `bots-changed`. |
| `ws:{workspaceId}` | `bots-changed` for everyone (a shared bot). |

- **Writers.** The chat route and `runBotTurn` call `startTurnPresence` once
  the thread's lock is theirs and `done()` after it is released (so a client
  never sees "idle" while the thread still refuses a message). The phase is
  derived by one LangChain callback handler, `PresenceCallbackHandler`,
  passed in `callbacks` to `streamEvents` and `invoke` alike: model start →
  *thinking*, tool start → *working*, text tokens → *talking*; the
  summarization middleware's own runs are ignored. `publishReply` after the
  turn is stored; `BotService` writes publish `bots-changed`. A Redis failure
  is logged once per command and never fails a turn.
- **`GET /api/bots/events`** (`src/app/api/bots/events/route.ts`, SSE,
  session-authed): on connect a `snapshot` — the bot list as `GET /api/bots`
  returns it (each bot carries `thread_id`) and the presence map — then the
  two channels forwarded; every 10 s the keys are re-read and
  expired ones announced; the stream closes at 240 s for `EventSource` to
  reconnect. The snapshot is authoritative, the events are the fast path.
- **Client** (`ChatProvider`): one `useEventStream` on that route, no polling
  (the 30 s / 4 s list polls, the post-load history poll and the @mention
  follow-up are gone; a `visibilitychange` refetch covers mobile Safari
  suspending the stream). `bot.busy` as every list reads it is the bot's live
  phase — minus the turn this tab is streaming itself, identified by the
  `X-Turn-Id` header the chat route returns. `livePhase` on `useChatThread()`
  carries the detail: the transcript's bubble says *Working* or *Writing*. A
  bot waiting on another bot's answer is not running a turn: no icon, no
  bubble, composer enabled. A `reply` for another turn **merges the thread's
  latest page into the one on screen at once** (`mergeLatestHistory` →
  `mergeHistoryTail` in `src/lib/chat/historyMerge.ts`, not while a turn
  streams) and marks it seen — another bot's message is appended without a
  refresh, and nothing already shown is rebuilt: a message the page confirms
  keeps its object (by id, or by role and text for a turn this tab streamed
  under the stream's ids), so no bubble blips — and for any other thread
  re-reads the list for the dot; one for the tab's own turn is ignored (it
  streamed it). The messages are never cleared and refetched for a reply;
  only switching bots reloads a thread. `useEventStream` reopens a stream the browser
  gave up on (a 401 or 503 answer leaves `EventSource` CLOSED for good) with
  a 1–30 s backoff, so a tab left open recovers once the server is well.

The active bot's avatar still follows the live stream while this tab is
streaming (`deriveAvatarState`); presence takes over when the tab is idle
(a refresh mid-turn, a background turn).

In the transcript, `ThinkingBubble` (the bot's avatar plus a cloud saying
"Deal Scout is thinking…" or "working…") replaces the plain spinner: from
sending until the first token, while tools run, and while the open bot
answers a mention or a routine in the background.

## Bot order: Brain Bot, pinned, then newest activity

Every bot list (the Copilot strip, the sidebar, the All bots menu, the Bots
page) uses one order, which `listVisible` returns:

1. **Brain Bot**, always.
2. **Pinned bots**, in the user's order: `bot_orders.bot_ids`, sorted by
   `array_position`. Ids of archived or no-longer-visible bots are ignored.
3. **The rest by newest activity**: `copilot_chats.last_message_at` of the
   user's thread with the bot (the latest stored reply, interactive or
   background), newest first. Never-used bots follow.
4. Then by name.

Dragging a bot (or Alt+←/→ on a strip tile, ↑/↓ on a menu handle) pins it
where it lands among the pinned bots (`pinAfterMove`, `src/lib/bots/order.ts`).
A pinned bot can't be placed below unpinned ones, since those follow activity.
The pin button in the All bots menu pins a bot last or unpins it.
`PUT /api/bots/pins` (`BotService.setPinned`) saves the list, keeping only
bots the user can see.

`ChatProvider.setPinnedBots` re-pins and re-sorts at once (`sortBots`, the
client twin of the SQL order) and then saves. A list read while a save was in
flight is re-pinned locally, so nothing snaps back; a failed save toasts and
reloads the server's order.

## UI

- `ChatProvider` loads the bots after sign-in, opens the remembered bot (in
  `localStorage`) or the default, and sends `bot_id` on every turn.
- The copilot header is the **bot strip** (`BotStrip`): each bot's avatar and
  name, the active one highlighted and live, unread dots, "New bot" (opens
  `BotEditDialog` in place) and "Manage" — which docks a full-screen copilot first (`revealConsole`), so the Bots page it opens is on screen rather than behind the chat.
  - Tiles are dragged to pin them in place (framer-motion `Reorder`), or
    moved with Alt+←/→. A drag that ends on a tile does not select it.
  - It shows only the tiles that fit, re-measured with a `ResizeObserver` as
    the pane resizes (`pickVisibleBots`, `src/lib/bots/order.ts`). The active
    bot always shows, taking the last slot if it falls past the cut.
  - When bots overflow, an **All bots** tile (`AllBotsMenu`) shows how many are
    hidden, with a dot if any of them is unread. It opens a large dropdown
    listing every bot in order, grouped "Pinned" and "Recent": click a row to
    open it, drag its handle (or focus it and use ↑/↓) to pin it there, or
    use its pin button.
- The sidebar lists the bots **above** Deal Flow and Intelligence. The
  "Bots" header carries **+** (the create dialog) and **Manage** (the Bots
  page). The list shows the first five bots (the active bot always among them,
  highlighted with a blue edge marker); "Show more (+N)" expands the rest in
  place and "Show less" folds them again. The Bots page is filed under the `bots` group in
  `src/lib/navigation/consoleTabs.ts`, so it is not listed under Intelligence;
  the collapsed icon rail still shows it.
- `/w/<slug>/bots` (`src/views/Bots.tsx`) lists, creates, edits and archives
  bots in **Shared** and **Private** (yours, led by your primary bot). Each grid uses `auto-fill` columns of at least 18rem, so
  it drops a column when the copilot pane narrows the page, not only at
  viewport breakpoints.
- `BotEditDialog` creates a bot from a name, shape and colour. An existing bot
  has three tabs: **Settings** (name, shape, colour, sharing, the **System
  prompt** editor and a live avatar preview), **Routines** (`BotRoutinesTab`: list,
  pause, run now, edit, delete, add) and **Task log** (`BotTaskLogTab`, grouped
  by day; a task opens the bot's chat). The bot cards open the dialog on any
  of them.
- `BotAvatar` is a framer-motion SVG character: a soft, glossy body with a
  dark visor and glowing eyes.
  - `shape` is the body: **Nova** (a sphere with a rim light), **Hexa** (a ring
    of hexagons), **Nimbo** (a cloud), **Orbit** (a ringed planet with a moon)
    or **Pixel** (a pyramid with a lit capstone) (`BOT_SHAPES`, `BOT_SHAPE_META`). Brain Bot alone
    wears **Apex**: a glossy black sphere with a large bezelled black visor,
    an amber light along its edges and tall white eyes (`BOT_BODIES`; the picker
    and the bot tools never offer it).
  - `hue` drives a two-hue pastel gradient with a specular highlight and edge
    shading; the eyes glow in the same hue.
  - `eyes` sets the resting eyes: pills (`round`), lidded arcs (`sleepy`),
    pills with a glint (`sparkle`) or one wide bar (`mono`). `mood` sets how
    it idles: `calm` floats slowly, `curious` tilts.
  - Its state comes from `deriveAvatarState`, and the eyes carry it: `^ ^`
    happy, `– –` thinking, `> <` error, `o o` waiting (an avatar state kept
    in `avatarState.ts` but not driven by anything today), a wink on handoff, a
    flutter while talking, a scan while working. With
    `prefers-reduced-motion` only the eyes change.
  - The bodies before the redesign (`robot`, `capsule`, `blob`, `cat`,
    `ghost`) were migrated to their closest new one, and `resolveBotAvatar`
    maps any old name it still meets (`LEGACY_BOT_SHAPES`).

### Timestamps and days

Every message carries `metadata.createdAt` (ISO): a history page stamps each
row's `created_at` (`ChatHistoryService.toUIMessage`), the live turn writes a
`message-metadata` chunk first thing so the streaming reply has one, and the
composer stamps the message it sends (`sentNow`). The bubble shows it as a
24-hour time under the message, on the side the message sits — bottom right
of the user's, bottom left of a bot's (`MessageTime`,
`data-testid="message-time"`; nothing when a message has no stamp). The transcript puts a date pill on a
rule above the first message of each day (`DaySeparator`,
`data-testid="day-separator"`): Today, Yesterday, the weekday within the
week, else "Tue, 14 Oct" with the year once it differs. `dayStarts` in
`src/lib/chat/messageTime.ts` reads through undated rows and relay groups so
a group's last message, not its first, sets the day for what follows. A user
bubble hugs its text — a short message is a short bubble on the right — and
caps at the width a long one always had.

## Mobile

Phones get their own shell (`AppShell` → `MobileShell`), with no sidebar,
docked pane or bottom nav.

- **The landing is a bot home** (`MobileBotHome`), laid out like Grok's:
  - **Top bar:** the Profile button on the left; Search (filters bots by name)
    and New bot on the right.
  - **Pinned tiles:** large avatars in rows of three, named underneath.
    Timeline (the activity feed, `/dashboard`) comes first, then Your tasks
    (`/tasks`; its icon turns red with a count when a reminder has passed),
    then Brain Bot, then the pinned bots. Brain Bot's tile swipes right for
    read/unread but never unpins.
  - **Every other bot** is a chat-list row: avatar, name, when it last spoke,
    its latest message as one plain line (`previewLine`), and an unread dot.
  - The preview is `last_message` on `BotDto`. `BotRepository.listVisible`
    reads it in the same query, as a correlated subquery on
    `idx_copilot_messages_chat_seq` (the newest message with text, capped at
    280 chars). Times come from `listTimeLabel`: the time today, the weekday
    this week, otherwise the date (`src/lib/bots/preview.ts`).
- **Six pinned slots.** Timeline, Your tasks and Brain Bot always take three.
  Bots fill up to three more (`MOBILE_MAX_BOT_PINS`, `splitMobileHome` in
  `src/lib/bots/order.ts`).
  - Pins are the same per-user pins desktop uses. Desktop has no cap, so a
    pin past the third shows in the list with a pin icon.
  - Pinning a fourth bot on mobile is refused with a toast.
- **Swipes** (`SwipeRow`, thresholds in `src/lib/mobile/swipe.ts`), iOS Mail
  style:
  - **Swipe right** on a row or a pinned tile marks the bot read or unread.
    `DELETE /api/bots/[id]/read` clears the thread's `last_read_at`. A
    hand-set unread dot survives the bot-list poll until that bot is opened
    (`keptUnreadRef` in `ChatProvider`). A bot with no reply yet has nothing
    to mark.
  - **Swipe left** on a row reveals **Pin** and **Edit**. A long swipe (half
    the row) pins or unpins at once, and the Pin action stretches as it arms.
    Swiping a pinned tile left unpins it. One row rests open at a time.
  - Keyboard: ← opens the actions (unpins a tile), → marks read or unread.
- **A bot opens its chat full-screen** (`MobileBotApp`).
  - The header is a back button, then the bot's avatar and name.
  - The open chat is in the URL (`?bot=<id>`), so the system back gesture
    returns to the home, and a reload or link reopens that chat.
- **Every other page** (Timeline, Profile, anything `navigate_page` opened)
  has a back bar to the home (`MobilePageBar`). The Search tab the bottom nav
  had is gone; Master Data is still reachable by link or from a bot.

- **Floating, liquid-glass controls.** Controls float over the content, which
  scrolls the full height beneath them behind a soft fade. On mobile that is
  every control: the home's Profile, Search and New bot buttons; the chat's
  back button, bot title and effort picker; the chat composer; a page's back
  button. On desktop it is the chat's header and composer (see below).
  - The material is `.liquid-glass` in `globals.css`: a saturated backdrop
    blur, a hairline edge lit along the top and a soft ambient shadow, with a
    near-opaque fallback where `backdrop-filter` is unsupported.
    `.liquid-glass-quiet` and `.liquid-glass-solid` are two weights of the same
    material for the desktop bot strip, which floats over the transcript: idle
    tiles and the New bot / Manage buttons wear the quiet one (enough fill for
    a legible label over scrolling text), the selected tile the solid one.
    `.liquid-glass-control` adds hover lift, press scale and a selected glow,
    and holds still under `prefers-reduced-motion`.
  - `LiquidGlass` and `LiquidGlassButton` (`src/components/ui/liquid-glass.tsx`)
    wrap it. These are overlays, so the opaque-card rule does not apply.
  - The transcript pads itself by the floating composer's measured height, so
    the newest message is never hidden behind it as the composer grows, and by
    the floating header's, so the first message clears it.
  - **The desktop chat uses the same layout.** In the docked pane and the
    expanded copilot, the bot strip header and the composer float over the
    transcript too: the transcript runs the full height of the pane behind a
    fade at the top (under the strip) and at the bottom (under the glass
    composer), so messages dim as they pass under either. Only the header's
    controls take pointer events; the faded band below them still scrolls the
    transcript. A user's own messages carry no avatar; the bubble alone marks
    them. On mobile the chat title's avatar is live and wears the strip's
    thought cloud while the bot responds, and a bot row on the home shows the
    cloud on its avatar as well as the "Responding…" line.

- **Chips under an answer fold away past three on mobile.** The "Open
  <company>" chips, Sources, web citations and Files each sit in a
  `ChipOverflow` row: after `MOBILE_CHIP_LIMIT` (3) chips the rest hide behind
  a "+N more" chip that expands them in place. Desktop shows every chip.

## Not built yet (RFC 02 later phases)

- Durable `'use workflow'` chat turns, human approval in chat, and the
  reconnect endpoint (Phase 0/1).
- Waiting for another bot's answer inside a turn (`ask_bot`, synchronous).
