import Anthropic from '@anthropic-ai/sdk';
import { createPptxTrace } from '@/lib/pptx/pptxLangfuse';

const anthropic = new Anthropic();

const SLIDE_SYSTEM_PROMPT = `You are an expert M&A presentation designer. You generate pure HTML slides for investment presentations.

## Critical Sizing Constraint
- The slide has a FIXED container of exactly 1120px wide × 630px tall (16:9 ratio).
- Your outermost element MUST be a single <div> with inline style: width:1120px;height:630px;overflow:hidden;position:relative;
- ALL content MUST fit within these exact pixel dimensions. NOTHING may overflow or extend beyond 630px in height or 1120px in width.
- If content is too long, REDUCE font sizes, SHORTEN text, REMOVE less important items, or USE multi-column layouts. NEVER let content overflow.
- Use compact spacing: prefer padding of 8-12px, margins of 4-8px, and line-height of 1.2-1.3.
- Bullet points should be very concise (1 line each, 2 lines max). Prefer short phrases over full sentences.

## Citation Footer (MANDATORY)
- Every slide MUST include a citation footer at the very bottom. This is NON-NEGOTIABLE.
- The footer should be positioned at the bottom of the slide using: position:absolute;bottom:0;left:0;right:0;
- Footer style: background:#f1f5f9; padding:4px 16px; font-size:8px; color:#64748b; border-top:1px solid #e2e8f0;
- List 1-3 relevant source citations as clickable hyperlinks (<a> tags with href, target="_blank", style="color:#2563eb;text-decoration:underline;").
- IMPORTANT: Look for "Available Sources for Citations" and "Company Website URL for citations" in the provided context. Use those REAL URLs in the citation footer.
- If specific source URLs are provided in the context, you MUST use them instead of making up URLs.
- If the company website URL is provided, always include it as a citation where relevant.
- Format: "Sources: <a href="URL">Source Name</a>, <a href="URL">Source Name</a>"
- If no source URLs are provided in the context, use plausible sources (e.g. company website, annual reports, industry databases, regulatory filings).
- Reserve ~20px at the bottom for this footer. Main content should not overlap with it.

## Rules
- Output ONLY the HTML content for the slide body. No <html>, <head>, <body>, or <style> tags.
- Use inline styles only. No external CSS or class-based styling.
- Use a clean, professional M&A / consulting style: dark navy headers, clean tables, subtle borders, professional color palette.
- Color palette: Navy (#1e3a5f), Dark Blue (#2563eb), Teal (#0d9488), White (#fff), Light Gray (#f8fafc), Slate (#475569).
- Use boxes with colored headers, tables, bullet points, and key metrics prominently displayed.
- Keep text extremely concise and data-dense. This is for investment professionals. Brevity is paramount.
- Use font-family: 'Inter', system-ui, sans-serif throughout.
- Make the slide visually rich: use colored boxes, metric callouts, mini tables, and structured layouts.
- For diagrams/arrows, use HTML/CSS (div borders, arrows via CSS triangles, flexbox layouts). No SVG or images.
- Fill the entire slide space efficiently. No large empty areas.
- Body text: 9-11px. Headers: 12-14px. Slide title: 16-18px. Table text: 9-10px.
- Prefer 2-column or 3-column layouts to fit more content horizontally rather than stacking vertically.`;

export const SLIDE_GENERATION_TIMEOUT_SECONDS = 480; // 8 minutes

export interface SlideGenerationPayload {
  instruction: string;
  currentHtml?: string;
  companyContext?: string;
  slideTitle?: string;
}

export interface SlideGenerationResult {
  html: string;
}

export async function runSlideGeneration(
  payload: SlideGenerationPayload,
): Promise<SlideGenerationResult> {
  const { instruction, currentHtml, companyContext, slideTitle } = payload;

  if (!instruction) {
    throw new Error('Missing required field: instruction');
  }

  let prompt = '';

  // An edit (existing slide HTML supplied) and a fresh generation are different
  // enough to be worth separating in the trace.
  const isEdit = Boolean(currentHtml);

  if (currentHtml) {
    prompt = `Here is the current HTML content of a slide titled "${slideTitle || 'Untitled'}":

\`\`\`html
${currentHtml}
\`\`\`

The user wants to modify this slide with the following instruction:
"${instruction}"

${companyContext ? `\n## Company Context\n${companyContext}\n` : ''}

IMPORTANT: Include a citation footer at the bottom of the slide with real source URLs from the context above. Generate the updated HTML for this slide. Output ONLY the HTML, nothing else.`;
  } else {
    prompt = `Generate an HTML slide titled "${slideTitle || instruction}" for an M&A investment presentation.

The user's instruction: "${instruction}"

${companyContext ? `\n## Company Context\n${companyContext}\n` : ''}

IMPORTANT: Include a citation footer at the bottom of the slide with real source URLs from the context above. Generate the HTML content for this slide. Output ONLY the HTML, nothing else.`;
  }

  // Raw SDK call, so there are no LangChain callbacks to hang a trace off —
  // build the span by hand, the same way the pptx skill does. runJob drains the
  // queue, but a trace only exists if something records it.
  const model = 'claude-sonnet-5-5';
  const trace = createPptxTrace('slide_generation', {
    mode: 'agent_slide',
    title: slideTitle || instruction,
  });
  const generation = trace.startGeneration({
    name: isEdit ? 'slide.edit' : 'slide.create',
    model,
    input: prompt,
    metadata: { isEdit, hasCompanyContext: Boolean(companyContext) },
  });

  let message;
  try {
    message = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: SLIDE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    generation.end({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
    });
    trace.end({ level: 'ERROR' });
    await trace.flush();
    throw err;
  }

  // Select by type, not position: Sonnet 5.5 thinks by default, so the first
  // block is a thinking block rather than the HTML.
  const content = message.content.find((b) => b.type === 'text');
  const rawText = content?.type === 'text' ? content.text : '';
  generation.end({
    output: rawText,
    metadata: { stopReason: message.stop_reason, usage: message.usage },
  });

  // Recorded before the truncation check so a max_tokens failure is visible in
  // the trace rather than only in the job's error message.
  if (message.stop_reason === 'max_tokens') {
    trace.end({ level: 'ERROR', statusMessage: 'truncated: max_tokens' });
    await trace.flush();
    throw new Error('Slide generation response was truncated (exceeded max output length)');
  }

  let html = rawText;

  const htmlMatch = html.match(/```html\s*([\s\S]*?)```/);
  if (htmlMatch) {
    html = htmlMatch[1].trim();
  } else {
    html = html.replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  }

  trace.end({ output: html });
  await trace.flush();

  return { html };
}
