---
name: release-notes
description: Generate formatted release notes from git history for this repo. Use when the user asks to "generate release notes", "write a changelog", "what changed since <ref>", or runs `/release-notes <since-ref>`. Groups merged work into Features, Enhancements, and Bugfixes.
---

# Release Notes

Turn git history into clean, customer-readable release notes grouped into three sections: **Features**, **Enhancements**, and **Bugfixes**.

## Inputs

- A starting ref (commit SHA, tag, or branch) — release notes cover everything from that ref up to `HEAD`. The user gives it as `/release-notes <ref>` or in prose ("since c304824", "since v1.2.0").
- If no ref is given, default to the most recent tag (`git describe --tags --abbrev=0`); if there are no tags, ask the user for a starting point rather than dumping the whole history.

## Steps

1. **Gather the commits.**
   - `git log <ref>..HEAD --format='%h%x09%s%n%b%n----'` to get subjects and bodies.
   - This repo squashes PRs to `main`, so each commit is usually one PR with its `(#NN)` number in the subject. Keep the PR number — it's a useful reference in the notes.

2. **Classify each commit** into exactly one section by intent, not just the literal word in the subject:
   - **Features** — net-new user-facing capability or endpoint (e.g. "Add chat endpoint", "Add Google SSO login", new HITL flows, new columns/screens). Subjects often start with `feat`/`feature`/`[FEAT]` or "Add ...".
   - **Enhancements** — improvements to existing behavior: UX/UI polish, redesigns, performance, refactors that change observable behavior (e.g. "Improve Company Card UX", "Enhance ... details", "save state of ...").
   - **Bugfixes** — corrections to broken behavior. Subjects often start with `fix`/`[FIX]`/`Hotfix`/`Bug`.
   - Internal-only plumbing with no user impact (e.g. tooling, CI, test fixes like "Fixed playwright UI automation", "Add terraform/redis") goes under a short **Internal** subsection at the end — or omit if the notes are customer-facing only. Use judgment and state which you did.

3. **Rewrite each line for a reader, not a committer.**
   - One bullet per PR. Start with a capitalized verb phrase describing the user-visible change.
   - Strip ticket prefixes (`[MB-xxx]`, `[FEAT]`) and `Co-authored-by` / session-link noise from the bullet text. You may keep the Jira id in parentheses if it adds value.
   - Append the PR reference: `(#NN)`.
   - Drop merge commits and version-bump-only commits.

4. **Emit the notes** in this format (omit any section with no items):

   ```markdown
   ## <version or date> Release Notes

   ### ✨ Features
   - <description> (#NN)

   ### 🚀 Enhancements
   - <description> (#NN)

   ### 🐛 Bugfixes
   - <description> (#NN)
   ```

   Use today's date or the version the user names as the heading. Order sections Features → Enhancements → Bugfixes. Within a section, order most-significant first.

## What not to do

- Don't paste raw commit subjects — rewrite them to read cleanly.
- Don't invent changes that aren't in the log, and don't merge unrelated PRs into one bullet.
- Don't classify by keyword alone; a commit titled "fix" that adds a new capability is a Feature.
- Don't include `Co-authored-by`, session URLs, or internal Slack links in the output.
