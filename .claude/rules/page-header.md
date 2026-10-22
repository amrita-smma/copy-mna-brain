# Page Headers

Every console page wears the same header band. It is one component —
`PageHeader` in `src/components/layout/PageHeader.tsx` — and a page does not
hand-roll its own title row.

## The rule

```tsx
<div className="min-h-full">
  <PageHeader
    title="Master Data"
    subtitle="Complete overview of all companies in the system"
    actions={<Button className="gap-2">Add Company</Button>}
  />

  <div className="space-y-6 p-6">{/* the page */}</div>
</div>
```

Three things make it correct:

1. **The band is full-bleed.** Its own `px-6 pb-7 pt-6` is the only padding it
   needs, so the page puts its padding on the content *below* the header, never
   on a wrapper around both. A page that keeps `p-6` on the outer container
   insets the gradient and the band stops reading as a band.
2. **The title is the page's only `<h1>`.** A list or section heading under the
   band is an `<h2>`. Playwright asserts `getByRole('heading', {level: 1})` on
   most pages, so a second `h1` breaks tests as well as the outline.
3. **The gradient is `.page-hero` in `globals.css`**, and it ends at
   `hsl(var(--background))` rather than a literal colour. That is what lets the
   same band sit on the `.suite-surface` token scope (Pipeline, Sourcing) and on
   a plain page without a seam under it. Do not re-hardcode the end colour.

## Slots carry meaning, not decoration

| Slot | For |
|---|---|
| `actions` | the page's controls, top-aligned right |
| `titleAdornment` | a status badge, a count, an edit affordance |
| `eyebrow` | a breadcrumb or back link above the title |
| `leading` | identity content only — the Profile avatar |
| `innerClassName` | align the title with a width-constrained body (`mx-auto max-w-[1180px]`) while the gradient stays full-bleed |

`leading` is **not** for a decorative icon tile. Half the pages used to open
with a gradient-filled rounded square and a `animate-ping` glow behind a lucide
icon; they were removed so the pages read as one product. Do not reintroduce
one.

## Banned: a hand-rolled title row

```tsx
// ✗ WRONG — a fourth variant of the same header
<div className="p-6 lg:p-8 space-y-8">
  <div className="flex items-center gap-3 mb-2">
    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/10">
      <Layers className="h-5 w-5" />
    </div>
    <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
  </div>
  <p className="text-muted-foreground ml-[52px]">…</p>
</div>
```

This is what the codebase looked like across twelve pages: headings ranging over
`text-xl`/`text-2xl`/`text-3xl`, `font-semibold` vs `font-bold`, subtitles
indented by a magic `ml-[52px]` to clear an icon, and three different
`bg-gradient-to-r … bg-clip-text` title treatments. If `PageHeader` cannot
express what a page needs, add a slot to `PageHeader` — do not fork it.

## Not every surface is a page

Leave alone:

- **Company Graph** — a full-bleed canvas whose title lives in a floating
  settings panel over it. A band would eat canvas.
- **Record detail views** (`CompanyDetail`, `CompanySlides`, `InsightView`) —
  the `h1` is the record's name inside a document surface, not a page title.
- **The chat** (`AICopilotPane`) — a transcript over a composer, with no title
  at all, by design (an empty thread is the same view, empty).
- **Auth and standalone pages** (login, reset-password, consent, workspace
  picker, admin portal) — they are outside `AppShell` and have no page chrome.

## Reviewing a diff

Reject a diff that:

- adds or edits a console page's title row without `PageHeader`
- leaves page padding on a wrapper that also contains the header
- introduces a second `<h1>` on a page
- passes a decorative icon to `leading`
- hardcodes the `.page-hero` gradient's end colour instead of `--background`
