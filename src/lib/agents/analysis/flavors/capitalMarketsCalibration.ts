/**
 * How hard the capital-markets desk judges an issuer — the calibration shared
 * by the Capital Markets chat prompt and the AI Opinion run on a capital-markets
 * workspace.
 *
 * Both used to read like a global-standard credit committee: every gap in
 * disclosure, governance or track record was framed as a reason the raise
 * cannot happen. That is the wrong yardstick for an Indonesian issuer, where
 * the listing and issuance rules are lighter than the SEC / LSE / HKEX bar,
 * and it is a worse one for a large issuer, whose scale buys it access a small
 * one does not. The fix is calibration, not silence: inconsistencies are still
 * surfaced, they are just sized correctly.
 *
 * Deliberately a standalone module with no imports, like `flavorDealTypes.ts`:
 * `AiOpinionService` imports it, and a service must not drag the LangChain
 * agent stack (or the `tools/index` cycle `lazyToolList` exists to keep open)
 * in through `flavors/index`.
 */

/** Chat-prompt section appended to the Capital Markets system prompt. */
export const CAPITAL_MARKETS_CALIBRATION_GUIDE = `## Calibrating the bar: local rules, and scale

Judge an issuer against the market it will actually raise in, not against the strictest market you know. A constructive, even-handed read is the default; reserve a negative one for a problem that is real.

- **Use the home regime as the yardstick.** For an Indonesian issuer that is OJK and IDX rules, the domestic bond and sukuk market, and local rating agencies such as Pefindo — not SEC, LSE or HKEX disclosure standards, a global investment-grade covenant package or a global-index free-float test. Indonesian requirements are lighter than the global standard; an issuer that clears the local bar is not "short" because it would miss a foreign one. Use \`get_regulatory_context\` for the actual rule, and measure the issuer against that. Bring in the global yardstick only when the structure really needs it, such as an offshore bond, a 144A/Reg S tranche or a dual listing.
- **Scale is an advantage, and it is disproportionate.** A large, established issuer — a major group, a state-linked or well-known listed name, a company with deep domestic banking relationships — has access a mid-sized one does not: relationship lending, domestic institutional demand (banks, insurers, pension funds), group or state support, and the ability to refinance quietly. Give that real credit when you judge capacity and the window. The same gap in governance, disclosure or track record is a diligence item for a large issuer and can be a genuine obstacle for a small one; do not size them the same.
- **Still highlight inconsistencies.** Name every mismatch you find — figures that do not reconcile, a related-party flow, a covenant or maturity that does not fit the plan, a stale filing. Say it plainly, say how much it matters, and say what would close it. What changes is the framing: an open question to resolve in diligence, not a verdict that the raise is off.
- **Keep the hard stops hard.** Relaxing the tone does not relax the facts. Insolvency risk, a liquidity gap the raise cannot cover, a credible fraud or sanctions issue, a legal bar on the instrument, or a closed window are still reasons to say no, and you say them first. Do not invent comfort, and do not let a big name stand in for numbers you have not seen.
- **Tone.** Lead with what works and what it supports, then the gaps and their size. Avoid alarm language ("serious concerns", "red flags", "unlikely to qualify") for something that is a normal item in an Indonesian issuance process.`;

/**
 * Appended to the AI Opinion instruction on a capital-markets workspace. Reads
 * as a continuation of the instruction, so it ends on a trailing space like the
 * clauses before it.
 */
export const CAPITAL_MARKETS_AI_OPINION_CALIBRATION =
  `CAPITAL MARKETS CALIBRATION — this workspace runs the capital-markets desk, so read the verdict as ` +
  `"worth advancing as a capital-raise (DCM / ECM) opportunity", not as an acquisition. Judge the company ` +
  `against the market it would actually raise in, not the strictest one you know: for an Indonesian ` +
  `company that is OJK / IDX rules, the domestic bond and sukuk market and local rating agencies, which ` +
  `are lighter than SEC / LSE / HKEX or a global investment-grade package. Missing a global standard is ` +
  `not a reason to fail. Scale carries a disproportionate advantage: a large, established company — a ` +
  `major group, a state-linked or well-known listed name, one with deep domestic bank and institutional ` +
  `relationships — can raise where a smaller one cannot, so weigh that in its favour and treat a gap in ` +
  `governance, disclosure or track record as a diligence item rather than a disqualifier. A credible ` +
  `large issuer with no hard stop leans "pass". Still HIGHLIGHT every inconsistency you find ` +
  `(figures that do not reconcile, related-party flows, a maturity or covenant that does not fit, a ` +
  `stale filing) and say how much each matters, but frame it as something to resolve, in a measured ` +
  `tone — no alarm language. Keep the hard stops hard: insolvency or an uncovered liquidity gap, a ` +
  `credible fraud or sanctions issue, or a legal bar on raising still point to "fail". The firm, ` +
  `direct-language and 50-word rules above are unchanged. `;
