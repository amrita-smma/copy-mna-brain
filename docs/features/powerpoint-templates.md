# Workspace PowerPoint templates (Default / StarCapital)

Each workspace has a **PowerPoint template**. A superadmin picks it from the
**PowerPoint Template** dropdown in the workspace configuration panel
(`/admin-portal`, Copilot tab, under Display Currency). The dropdown `PATCH`es
`/api/workspaces/{id}` with `{ pptx_template }`.

- Persisted on `workspaces.pptx_template` (text, default `'default'`; migration
  `20261028000001_add_workspace_pptx_template`). `WorkspaceService.getPptxTemplate`
  and `updatePptxTemplate` read and write it; an unknown value reads back as
  `'default'`.
- `src/lib/pptx/templates/catalog.ts` holds the client-safe ids and labels
  (`PPTX_TEMPLATE_IDS`, `normalizePptxTemplate`).
- `src/lib/pptx/templates/index.ts` holds the server-only definitions.
  `getPptxTemplate(id)` returns the template's master (logo, page tab,
  confidentiality line, page number), or `null` for `'default'`.
- Brand images live in `src/lib/pptx/templates/assets/<template>/`, outside
  `public/` so they are not downloadable. They are read with `fs`, so
  `next.config.ts` pins the directory into `/api/**` via
  `outputFileTracingIncludes`.

## What follows the setting

The Pipeline **Present** download (`POST /api/pipeline/presentation/pptx`; see
[Pipeline Present](pipeline-presentation.md)):

- **StarCapital:** every slide sits on the StarCapital master.
- **Default:** plain slides with no logo or branding.

Nothing else reads the setting. The Copilot's decks (the pptx skill), the
Company Card export and the HTML slide export are unchanged.

## StarCapital

The source is the "Starcapital Slide Templates" deck. The master reproduces
its "1_Content 1 Section" layout:

- the logo at the top right;
- the navy page tab carrying a white page number at the bottom right;
- "STRICTLY PRIVATE AND CONFIDENTIAL" centred at the foot.

## Adding a template

1. Add the id and label to `catalog.ts`.
2. Put its images under `assets/<id>/`.
3. Add its `PptxTemplate` to `TEMPLATES` in `index.ts`, with the master objects
   measured from the template's content layout.
