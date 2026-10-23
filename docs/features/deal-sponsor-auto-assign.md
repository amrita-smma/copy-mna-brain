# Deal Sponsor auto-assignment (MB-830)

A company detected in an email lands in Pending Confirmation (`unreviewed`)
with no owner. Auto-assignment fills its **Deal Sponsor** with the workspace
member most likely to own it, and the company card says the pick was
automatic.

Only the sponsor is filled. The Deal Captain shows from L3 onward and copies
the sponsor on entry to L3 (`companyService` stage move), so an auto-assigned
sponsor becomes the captain with no extra rule.

## When it runs

`FileService` calls `DealSponsorAssignmentService.assignForNewCompanies` for
the companies a file just created, when the file came from an email
(`files.source_sender_email`):

- **Email ingest** (`processUpload`): right after `linkFromSmartFile` writes the
  sender's `deal_contacts` links, and before the companies go to auto-scan.
- **One-click create from a file** (`createCompanyFromFile`): it links the
  sender first, then assigns.

It runs inline in the file-processing job (a fixed handful of bulk queries,
whatever the number of companies), and a failure is logged and never fails the
upload. It only fills an **empty** sponsor on an **active, pre-pipeline**
company, and the write is conditional (`deal_sponsor IS NULL`), so a sponsor
someone set in the meantime is never overwritten.

## Scoring

Pure and deterministic, in `src/lib/pipeline/sponsorScoring.ts`. Recency is
measured from the new company's `created_at`, not the clock, and only deals
created before it count, so a re-run or a backtest gives the same pick.

| Signal | Points | Cap |
|---|---|---|
| **Banker history**: each past deal of the sending banker (`deal_contacts`) the user owns (captain, else sponsor) | 3 × stage × recency, × 0.5 if dropped, × 0.5 if the banker was only `involved` | — |
| **Firm coverage**: the user covers the banker's firm (`employer_team_members`) | 4 | — |
| **Track PIC**: the user is PIC of a Track saved on the company (`matched_track_ids`; never the keyword guess) | 3 | — |
| **Sector**: each past deal the user owns with the same `segment`, any banker | 1 × stage × recency, × 0.5 if dropped | 4 |
| **Country**: each past deal the user owns with the same `geography` | 0.25 | 1 |
| **Mailbox owner**: `entered_by` received the email | 1 | — |

- **Stage:** L0 × 1, L1 up to L3 × 1.5, L3 onward × 2, by the workspace's stage
  order. Banker history uses the furthest stage a deal's logs show; sector and
  country use its current stage. Pre-pipeline deals never count.
- **Recency:** under 6 months × 1, 6–18 months × 0.6, older × 0.3.
- **Sector/country matching:** lowercase, `&` read as "and", whitespace
  collapsed — exact after that, no fuzzy matching. The SQL in
  `companyRepository.findOwnedDealsForSponsorMatch` applies the same rule.
- A deal counted as banker history is not counted again as a sector deal.
- A Track PIC is a free-text name; it counts only when it names exactly one
  workspace member.
- Only active workspace members score.

**Threshold:** nobody is assigned below 3 points. The card then keeps showing
the matched Track's PIC as before. Without the threshold the mailbox owner's
1 point would win every deal nothing else knows about.

**Ties:** most recent deal with this banker, then the mailbox owner, then
fewer active deals (read only when a tie is still standing), then the lowest
user id.

**No feedback loop:** a past deal whose sponsor is still an earlier
auto-assignment and that never got past L0 is ignored — auto-scan alone can
take a deal to L0, so it proves nothing. Once someone moves it past L0 it
counts.

## The disclaimer

Each assignment writes a `company_logs` row: action
`AUTO_ASSIGNED_SPONSOR:<user id>`, reason in `comments` (e.g. "2 past deals
with Jane Doe · covers Firm X"). The reason stays out of the action because
stage-move readers pattern-match actions (`%_TO_%`).

`CompanyService.findByIdDTO` and `listDTO` set `deal_sponsor_auto_reason` while
the company's sponsor still equals the user the latest auto log names, so any
manual change clears it at any stage. The shared `CompanyDetailsTab` renders
"Auto-assigned when the email arrived: <reason>" under the Deal Sponsor field,
so the pipeline dialog and the company page show the same thing. It is hidden
once the field shows the Deal Captain (L3 onward) or the user picks someone
else in the editor.

No new table or migration: it reads `deal_contacts`, `correspondents`,
`employer_team_members`, `investment_thesis`, `companies` and `company_logs`,
and writes `companies.deal_sponsor` plus one `company_logs` row.
