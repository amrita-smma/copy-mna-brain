# Presentation page (`/presentation`)

A distraction-free, full-screen file viewer for PDF and PPTX files — the file only, no AI summaries. PDFs render in an `<iframe>`; PPTX renders via the Microsoft Office Online embed (`view.officeapps.live.com`), which fetches the file's signed URL.

- **Entry point:** the full-screen button on any `FilePreview` popup (chat files, company attachments, Smart Files) navigates here with the file's S3 key. Direct visits with no file selected show the user's recently-opened files, paginated by 10 (most recent first).
- **Recently-opened files** are stored per-user in the `recent_files` table (one row per `(user_id, file_key)`; re-opening bumps `opened_at`). Signed URLs are regenerated server-side from the stored S3 key, so entries stay openable after the original signed URL expires.
- Layers: `RecentFileRepository` → `RecentFileService` (wired in `container.ts`).

## API Endpoints

- `GET  /api/recent-files?page=N` — list the current user's recent files (page size 10)
- `POST /api/recent-files` — record an open `{ fileName, fileKey }` (upsert)
- `GET  /api/recent-files/signed-url?key=…&name=…` — resolve a fresh signed URL for a file key

All three are session-authenticated via `auth()`.
