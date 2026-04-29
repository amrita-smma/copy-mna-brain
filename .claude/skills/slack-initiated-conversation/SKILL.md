---
name: slack-initiated-conversation
description: Use when Claude Code is being called from Slack. Optimizes for limited back-and-forth conversations by taking the simplest solution when stuck. By default, creates a new branch, pushes to remote, creates a PR, and displays both the PR link and deployment preview.
---

# Slack-Initiated Conversation

This skill is activated when Claude Code receives a request from Slack. Due to the asynchronous nature of Slack conversations and limited back-and-forth, this skill optimizes for decisive action and complete delivery.

## Principles

1. **Take the simplest solution** — When facing ambiguous choices, pick the straightforward option rather than asking clarifying questions.
2. **Complete the full workflow** — Don't stop at partial completion; push code and create PRs by default.
3. **Be proactive** — Anticipate what the user needs next and provide it upfront.
4. **Provide all links** — Always include PR URL and deployment preview link in the response.

## Default Workflow

When implementing a feature or fix from Slack:

1. **Create a new branch.**
   - Branch name format: `claude/<short-description>-<random-id>` or use the assigned branch if provided.
   - `git checkout -b <branch-name>`

2. **Implement the changes.**
   - Make the minimal viable change that satisfies the request.
   - When facing design decisions, choose the simpler approach.
   - Add unit tests if modifying `src/lib/**` (per CLAUDE.md).

3. **Commit and push.**
   - Write a clear, concise commit message.
   - `git push -u origin <branch-name>`
   - Retry with exponential backoff on network failure (2s, 4s, 8s, 16s).

4. **Create the PR.**
   - Use `mcp__github__create_pull_request`.
   - Include in the PR description:
     - Summary of changes
     - Link to the Slack thread (from `slack_context` if available)
     - Test plan or verification steps
   - Base branch: `main` (unless otherwise specified).

5. **Display the PR link.**
   - Output the PR URL immediately after creation.

6. **Display the deployment preview.**
   - Wait briefly for Vercel to post the deployment comment.
   - Use the `display-pr-deployment` skill or manually fetch the preview link.
   - If deployment is still building, note that and provide the PR link where they can check status.

## Output Format

After completing the workflow, provide:

```
**PR Created**
<pr-url>

**Vercel Preview** (available after build completes)
<deployment-url or "Building...">

**Changes:**
- <bullet summary of what was changed>
```

## Decision Heuristics

When stuck on a choice:
- **File location unclear?** Follow existing patterns in the codebase.
- **Multiple implementation approaches?** Pick the one with less code.
- **Unclear requirements?** Implement the literal interpretation, note assumptions in PR description.
- **Test coverage?** Add tests for `src/lib/**`, skip for trivial UI changes unless specifically requested.

## What not to do

- Don't ask clarifying questions unless absolutely necessary — make a reasonable choice and document it.
- Don't leave the branch unpushed — always push and create PR.
- Don't forget the Slack thread link in PR descriptions when `slack_context` is available.
- Don't provide partial updates — complete the full workflow before responding.
