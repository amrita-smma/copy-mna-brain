# CRM editing, per workspace

What a person can change on a CRM firm card, and why none of it leaks into
another workspace.

## Shared rows, per-workspace edits

A firm (`employers`) and a person (`correspondents`) are **shared** rows: the
email ingest owns them, and every workspace that syncs a mailbox emailing that
person can see them (`workspace_correspondents`). Everything a human — or the
`@crm_contact` agent — sets on top of them is stored **per workspace**:

| What | Table | Key |
|---|---|---|
| Contact profile edits (name, title, phone, desk/focus fields, LinkedIn, and the bio Get Full Profile writes) | `correspondent_curation` | `(workspace_id, correspondent_id)` |
| Firm name / industry edits, and the chosen PIC | `employer_curation` (`primary_correspondent_id`) | `(workspace_id, employer_id)` |
| Team assignee | `employer_team_members` | `(workspace_id, employer_id, user_id)` |
| Topic tags (manual and auto) | `employer_topics` | unique `(workspace_id, employer_id, topic_id)` |

Already per workspace before this: related companies, firm notes, relationship
overviews and deal roles. Still shared: the ingest's own values,
email addresses, the inbound/outbound status, flagged/published, domain
overrides and per-email AI notes.

## Reads

User-facing reads go through two views, always filtered on `workspace_id`:

- `correspondent_workspace_effective` — one row per contact **visible** in a
  workspace (it joins `workspace_correspondents`, so visibility is built in),
  with that workspace's profile edits COALESCEd over the shared row.
  `is_primary` is true only for the workspace's picked PIC; readers sort it
  first and fall back to the oldest contact.
- `employer_workspace_effective` — one row per (workspace, firm) with that
  workspace's name/industry and `primary_correspondent_id`.

The global `correspondent_effective` / `employer_effective` views keep their
columns but no longer apply any overlay: they are the shared row only, for
matching by key (email, normalized name) and the analytics dims.

The ingest writes auto tags and team coverage into each workspace the email's
custodian syncs into (`emailProcessCrm.ts`, the same `wsCache` that scopes
contact memberships).

## What the card lets you edit

| Where | Action | Route |
|---|---|---|
| Card → **Edit firm** | name, industry, team (this workspace's members only) | `PATCH /api/crm/employers/:id`, `PUT …/team`, picker from `GET /api/crm/workspace-members` |
| Contact row ★ | make primary contact | `PUT /api/crm/employers/:id/primary-contact` |
| Contact row ✎ | every contact field except the bio | `PATCH /api/crm/correspondents/:id` |
| Contact row 🗑 | remove from **this workspace** (unlinks `workspace_correspondents`; the shared row and other workspaces are untouched; a synced mailbox emailing them again re-links them) | `DELETE /api/crm/correspondents/:id` |
| Related companies × | manual link: deleted; auto suggestion: dismissed (`dismissed_at`, which the ingest never clears) | `DELETE …/related-companies/:id` |
| Topics tab | add / remove / reclassify tags | existing topic routes |
| Notes tab | add, edit, delete — anyone in the workspace; see below | `…/notes`, `…/notes/:noteId`, `…/notes/:noteId/revisions` |

**Not editable by hand:** the bio. It is the AI-generated profile — the Edit
dialog has no field for it and `pickEditableContactFields` drops it; only Get
Full Profile / Refresh write it. **Source** (Auto/Manual) is provenance — Auto
means the firm came from email ingestion — so it is shown, not edited.

## Firm notes are audited

Any member can edit or delete any note. Every create, edit and delete writes an
`employer_note_revisions` row (content before and after, who, when) in the same
transaction as the change (`EmployerNoteRepository.*WithRevision`). Deletes are
soft (`deleted_at` / `deleted_by`) so the history outlives the note; the Notes
tab's History button shows it. The author and editor come from the session,
never the request body.

## Migration

`20261023000000_crm_per_workspace_curation.sql` adds the keys and views and
backfills: each existing overlay, tag and team row is copied into every
workspace that can see the firm or contact today, so no edit is lost. "Sees the
firm" is the CRM list's own rule (`EmployerRepository.buildWhere`): a visible
contact, a live related-company link, a firm note, or a private topic on it.
Team rows go to the workspaces where that user is a member, or to all of them
if the user is a member of none.
