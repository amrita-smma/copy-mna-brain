# Track screening pass rule (must-pass + minimum optional criteria)

Each Track's screening criteria are split into **must-pass** and **optional**,
and the track sets how many optional criteria have to pass. That rule decides
whether the company passes the track's AI Screening — everywhere a verdict is
shown or acted on.

## Configuring it

Pipeline → Configuration → Investment Track → *track* → **Criteria**
(`ScreeningCriteriaManager`):

| Control | Stored on | Saves |
|---|---|---|
| **Must-pass** switch on a criterion (and on the add form) | `criterias.must_pass` | immediately (`PATCH /api/criterias/:id` `{ mustPass }`) |
| **Minimum optional criteria to pass** | `investment_thesis.min_optional_criteria_pass` | with the track (Save → `POST /api/investment-thesis` `{ min_optional_criteria_pass }`) |

The bar beside the minimum shows it as a share of the track's optional
criteria, rounded to a whole percent (`optionalPassThresholdPercent`). The
minimum must be a whole number ≥ 0, or empty/`null` (400 otherwise —
`InvalidTrackPassRuleError`). A minimum above the optional count is capped at
it, and the UI says so.

## The rule

`trackScreeningVerdict` in `src/lib/screening/verdict.ts`:

- **fail** — any must-pass criterion fails (an `error` result counts as a
  fail), or so many optional criteria failed that the minimum can no longer be
  reached.
- **pass** — every must-pass criterion passed **and** at least the minimum of
  optional criteria passed. No individual optional criterion is required.
- **inconclusive** — anything else (e.g. a must-pass criterion came back
  inconclusive).

A track with **no must-pass criteria and no minimum** (or a minimum of **0**,
which means the same thing) keeps the default rule (≥3 passes, ≤1 fail), so
tracks configured before this feature behave exactly as they did. A track with
must-pass criteria but no minimum needs only the must-pass ones.

A company passes AI Screening when any matched track passes
(`companyScreeningVerdict`, which takes the per-track rules).

## Where it applies

- **AI Opinion** — `AiOpinionService.dispatch` inlines an *AI SCREENING
  RESULTS* block (`AIScreeningService.summarizeForOpinion`): per matched track,
  its verdict under this rule, each must-pass criterion's result, and optional
  passes against the minimum. The instruction tells the agent a failed
  must-pass criterion is a hard stop for that track. Best-effort: a read
  failure drops the block, never the opinion.
- **Pending Confirmation auto promote / auto drop** and the `tracks`-mode screening
  task — the rules come back from `AIScreeningService.screenMatchedTracks`
  (`rules`, built by `buildTrackPassRules`).
- **AI Screening panel** and the company dialog's **Pre-pipeline Filters** tab
  — `/api/screenings` rows carry `criterias.must_pass` and
  `track.min_optional_criteria_pass`, and `trackPassRuleFromRows` rebuilds the
  rule client-side. The dialog tags must-pass criteria.
