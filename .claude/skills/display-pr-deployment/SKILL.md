---
name: display-pr-deployment
description: Display the Vercel deployment preview link for a PR. Use when the user asks for "deployment link", "preview link", "Vercel preview", or "where can I test this PR". Finds the link in PR comments made by Vercel under the Preview hyperlink.
---

# Display PR Deployment

Retrieve and display the Vercel deployment preview link for a pull request.

## Inputs

The user provides a PR number (`/display-pr-deployment 42`) or no argument (use current branch's PR).

## Steps

1. **Identify the PR.**
   - If PR number given: use that number directly.
   - If no arg: find the PR for the current branch using `mcp__github__list_pull_requests` or similar.

2. **Fetch PR comments.**
   - Use `mcp__github__pull_request_read` to get the PR details and comments.
   - Look for comments from the Vercel bot (author login typically contains "vercel").

3. **Extract the Preview link.**
   - In Vercel's comment, find the deployment URL under the "Preview" section.
   - The link typically follows the pattern `https://<project>-<hash>-<team>.vercel.app` or a custom domain.
   - Look for markdown links with text "Preview" or URLs containing `.vercel.app`.

4. **Display the result.**
   - Output the deployment link clearly to the user.
   - If multiple deployments exist (multiple commits), show the most recent one.
   - If no Vercel comment found, inform the user that deployment may still be in progress or Vercel is not configured.

## Output Format

```
**Vercel Preview Deployment**
<deployment-url>

Commit: <short-sha>
Status: <Ready | Building | Failed>
```

## What not to do

- Don't guess the URL format — always extract from the actual Vercel comment.
- Don't fail silently if no deployment found — explain what's happening.
