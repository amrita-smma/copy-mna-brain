# In-app Copilot chat attachments

Files can be dropped **anywhere on the Copilot pane** (or picked via the
paperclip) and referenced by the agent. **Any file type** is accepted, up to
**100 MB** per file (`MAX_ATTACHMENT_BYTES`; larger files are rejected client-side
with a toast). These are **plain S3 objects** — deliberately NOT the Smart Files
`files` table, and they never run through the extraction / company-matching
pipeline.

Lifecycle:

- **Attach → S3.** On drop, the browser fetches a presigned PUT URL from
  `GET /api/chat/attachments/upload-url` and uploads directly to S3 under
  `chat-attachments/{workspaceId}/…` (`generateChatAttachmentKey`). The key is
  scoped by workspace so a request can only ever reference its own tenant's
  files. The S3 object is the **durable** store — it persists across turns.
- **Send → Anthropic.** On every chat turn, `/api/chat` downloads each attached
  S3 object. **PDFs and images** are uploaded to Anthropic's Files API
  (`files-api-2025-04-14` beta, enabled on the chat `ChatAnthropic`) and
  referenced as `file` content blocks. **Every other type** (docx, pptx, xlsx,
  csv, json, …) is text-extracted via `extractTextFromFile` and inlined as a
  labelled text block — the Files API only accepts PDF/plaintext/images, so this
  is what lets *any* file type be sent. An HTML file over 20,000 characters is
  sent to chat as an outline instead (see *Large documents*). Because the
  S3 object persists, the file is re-referenced on **every subsequent turn** of
  the conversation.
- **Cleanup (done / stopped / disconnected).** The per-turn Anthropic upload is
  ephemeral: it is deleted once the streamed response drains (`after()`), and
  also on `req.signal` abort — which covers the UI's stop button and a dropped
  SSE connection. Teardown is idempotent so both paths are safe.
- **Multi-turn.** Because each turn's Anthropic upload is deleted, the `file`
  block persisted in the checkpointed history would 404 when the next turn
  replays it. So on every follow-up turn `AgentGraph.rewriteFileReferences`
  repoints the history's stale `file` blocks at the freshly re-uploaded id
  (`rewriteStaleFileBlocks`, reusing each message's id and `additional_kwargs` so
  the reducer overwrites in place and the recorded attachment refs survive) — or
  neutralizes them to a text placeholder if the file was removed.
- **Remove → S3 delete.** Removing a chip (`DELETE /api/chat/attachments`) or
  starting a new chat deletes the S3 object. This is the only thing that removes
  the durable file.
- **Email an uploaded HTML file.** `send_email`'s `attached_html` mails an
  attached `.html` file **as the email's body**. The model names the file
  (`file_name`, optional when only one HTML file is attached) and never retypes
  it: the bytes are read back from S3 (`ChatAttachmentService.download`, same
  workspace-prefix guard as every other key), so this works even for a file
  that only reached the model as an outline. The file is resolved from the
  turn's `attachments` (or the thread's most recent earlier ones) on
  `configurable`, so "email me that page" works on a later turn too, and a
  handed-off Workforce run gets the same refs on its tool config.

  The file is **not** forwarded untouched. Mail clients run no JavaScript and
  strip most of what a modern page is built from, so a client-rendered page
  sent verbatim arrives as its `<noscript>` apology — *"This page requires
  JavaScript to display"*. `toEmailSafeHtml` (`src/lib/email/emailSafeHtml.ts`,
  parsing with `node-html-parser`) rewrites the document into the subset that
  does render: `<script>`, `<noscript>`, frames, `<canvas>`, media and form
  controls are dropped, `on*` handlers and `javascript:` URLs with them, images
  whose `src` cannot resolve from an inbox (relative paths, `blob:`) are removed
  rather than left as broken icons, and the document's own `<style>` rules are
  kept with bare `html`/`body` selectors re-rooted onto the `.brain-doc` wrapper
  so they cannot repaint the surrounding email. The result rides inside the
  branded shell under the agent's note (`renderAgentEmail`'s `documentHtml`, at
  900px instead of the 600px notification width); `body` stays the note and the
  plain-text alternative.

  Nothing executes the page, so a document whose content exists only after its
  scripts run has nothing left to send. That is **refused**, not mailed: the
  tool returns an error naming the file and quoting what the page does render,
  and the agent is told to offer a PDF instead. The detection is deliberately
  not just "is there any text" — a single-page-app export shows a logo and a
  spinner, which is text. `meaningfulText` discounts loading boilerplate
  ("Unpacking…", "Loading", "Memuat", "requires JavaScript"), and a document
  that carries scripts is refused when what is left is under 15 characters (the
  floor that needs no phrase list, since plenty of shells animate a CSS ring
  and write nothing), under 40 with loading copy, under 200 while carrying 20KB+
  of script, or under 200 with an app mount point (`#root`, `#app`, `#__next`,
  `[data-reactroot]`) still empty. The bundle test measures script bytes rather
  than file size, so a report that inlines a large `data:` image is not
  mistaken for an app; a picture with no caption is still a document, and a
  short memo carrying an analytics snippet still sends. What the
  rewrite removed is reported back so the confirmation sentence can say so. Bodies go out base64-encoded in the MIME part
  (`ses.ts`), since a real document carries non-ASCII text and lines past the
  SMTP limit that `7bit` cannot carry intact.

Layering follows the handler → service convention: both route handlers and
`/api/chat` delegate to `ChatAttachmentService`
(`src/lib/services/chatAttachmentService.ts`) for the presigned-URL,
S3-delete, and Anthropic upload/delete operations. Client state (the attachment
list, upload progress, and the transport body that carries `attachments`) lives
in `src/components/chat/ChatProvider.tsx`; the drag-drop / paperclip / chip UI is
`src/components/chat/ChatComposerAttachments.tsx`, wired into both the full
`ChatWindow` composer and the `AICopilotPane` composer.
