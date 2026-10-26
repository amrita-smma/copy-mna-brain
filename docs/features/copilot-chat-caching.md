# In-app Copilot chat caching

> **Status: not wired into the current chat route.** `POST /api/chat` runs
> every turn on a permanent bot thread (`docs/features/copilot-bots.md`) and
> no longer records `first_user_message`; `/api/chat/cache-check` is not in
> the tree. This page describes the earlier per-chat design and is kept for
> the data model it introduced. For *prompt* caching (Anthropic cache
> breakpoints), see the "Prompt caching" note in `copilot-bots.md`.

The in-app Copilot (`/api/chat` + `src/components/chat/ChatProvider.tsx`)
short-circuits repeated questions. On the **first turn of a new chat** the
client first asks whether the same question was already answered, and on a hit
renders the cached turn-1 **inline** as chat bubbles — the user's question, then
the cached AI answer wrapped in a dotted border (labelled *"Cached chat history
found on &lt;date&gt;"*) with two CTAs beneath it: **Continue from chat** or
**Start fresh** (`src/components/chat/CachedChatPreview.tsx`).

How it works:

- Each chat's first user message is recorded on the `copilot_chats` row as
  `first_user_message` plus `first_user_message_hash` — a SHA-256 of the
  **normalized** message (`trim` + lowercase + collapsed whitespace), indexed
  for lookup. Recording happens in `/api/chat` only for a brand-new chat (no
  `chat_id`), and only **after the run finishes** (a Next.js `after()` hook
  reads the persisted turn-1 once the response stream closes and records the
  key only when the assistant produced a complete, substantial answer). Partial,
  aborted, or errored runs are never cached; resumed threads never overwrite it.
- `POST /api/chat/cache-check` (`{ message }`) hashes the message via
  `CopilotChatsService.findCachedFirstTurn` and, on a **global** match (any
  user), reads the matched thread's turn-1 from the checkpointer
  (`AgentGraph.getMessages` → `extractFirstTurn`). It returns the cached
  question + answer only when that turn-1 produced a **substantial** answer —
  more than 6 words (`isCacheableResponse`); trivially short replies aren't
  worth reusing. Strictly turn-1: later turns carry context that could mislead a
  reused answer.
- **Continue from chat** forks rather than opening the source thread (which may
  belong to another user). `POST /api/copilot/chats/fork` (`{ sourceChatId }`)
  creates a new chat owned by the caller and seeds its agent thread with the
  cached turn-1 (`AgentGraph.seedMessages`), switches to it, and focuses the
  chat input so the user continues with that context in an isolated, owned
  conversation. **Start fresh** discards the preview and runs the agent normally.

Layering follows the handler → service → repository convention: the two new
route handlers delegate to `CopilotChatsService` (`recordFirstMessage`,
`findCachedFirstTurn`) → `CopilotChatsRepository` (`recordFirstMessage`,
`findLatestFirstMessageMatch`), with turn-1 extraction and checkpoint seeding in
the agent layer (`src/lib/agents/analysis`).
