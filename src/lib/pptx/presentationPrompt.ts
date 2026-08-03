/** Shared anti-hallucination rules for agent-generated PPTX decks. */
export const PRESENTATION_DATA_FIDELITY_RULES = `## Data fidelity (MANDATORY)
- Use ONLY facts present in the brief and Company Context below.
- Do NOT invent, infer, estimate, or "fill in" shareholders, org structure, products, customers, financials, multiples, citations, or URLs.
- If a field or section lacks data, show "N/A" or "Insufficient data" — do not invent placeholders that look like real facts.
- Prefer sparse/accurate over dense/guessed. Empty space is better than made-up content.
- Citation footers: only real URLs from context. If none, omit links or write "Sources: N/A" — never invent URLs.`;

export function buildAgentPresentationPrompt(opts: {
  title: string;
  brief: string;
  companyContexts?: string[];
}): string {
  const contextBlock =
    opts.companyContexts && opts.companyContexts.length > 0
      ? opts.companyContexts.map((c, i) => `### Company ${i + 1}\n${c}`).join('\n\n')
      : '(No structured company records were attached — rely only on the brief.)';

  return `Create a complete PowerPoint (.pptx) presentation titled "${opts.title}".

## Brief (follow this — structure, slide count, and tone are flexible)
${opts.brief}

## Company Context
${contextBlock}

${PRESENTATION_DATA_FIDELITY_RULES}

## Output
- Produce a polished, professional deck suitable for an M&A / investment audience.
- Choose slide count and layout from the brief — do NOT force a fixed 7-slide template.
- Save a single .pptx file and stop when done.`;
}
