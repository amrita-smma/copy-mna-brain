'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';

interface SlidesPageProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Loader2,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Send,
  Pencil,
  Copy,
  Presentation,
  X,
  FileText,
  Save,
  ZoomIn,
  ZoomOut,
  RefreshCw,
  Download,
} from 'lucide-react';
import { getCompanies } from '@/lib/api/pipeline';
import { waitForJob } from '@/lib/jobs/useJob';

async function generateSlideHtml(body: {
  instruction: string;
  currentHtml?: string;
  companyContext?: string;
  slideTitle?: string;
}): Promise<string> {
  const res = await fetch('/api/slide-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`slide-generate failed: ${res.status}`);
  const { jobId } = (await res.json()) as { jobId: string };
  const job = await waitForJob(jobId);
  if (job.status !== 'completed') {
    throw new Error(job.error || `Slide generation ${job.status}`);
  }
  const result = (job.result ?? {}) as { html?: string };
  if (!result.html) throw new Error('Slide generation produced no HTML');
  return result.html;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlideRow {
  id: string;
  company_id: string;
  title: string;
  html: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface CompanyData {
  id: string;
  target: string | null;
  segment: string | null;
  pipeline_stage: string | null;
  website: string | null;
  geography: string | null;
  ownership: string | null;
  company_focus: string | null;
  comments: string | null;
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ev_2024: number | null;
  ebitda_margin_2021: number | null;
  ebitda_margin_2022: number | null;
  ebitda_margin_2023: number | null;
  ebitda_margin_2024: number | null;
  l1_screening_result: string | null;
  remarks?: string | null;
}

interface AnalysisSource {
  type: string;
  url?: string;
  title?: string;
}

interface CompanyAnalysis {
  business_overview: string | null;
  business_model_summary: string | null;
  key_takeaways: string | null;
  investment_highlights: string | null;
  investment_risks: string | null;
  diligence_priorities: string | null;
  sources: AnalysisSource[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCompanyContext(company: CompanyData, analysis: CompanyAnalysis | null): string {
  const lines: string[] = [];
  lines.push(`Company: ${company.target || 'Unknown'}`);
  if (company.segment) lines.push(`Segment: ${company.segment}`);
  if (company.geography) lines.push(`Geography: ${company.geography}`);
  if (company.ownership) lines.push(`Ownership: ${company.ownership}`);
  if (company.company_focus) lines.push(`Focus: ${company.company_focus}`);
  if (company.website) lines.push(`Website: ${company.website}`);
  if (company.comments) lines.push(`Comments: ${company.comments}`);
  if (company.remarks) lines.push(`Remarks: ${company.remarks}`);

  const fin: string[] = [];
  if (company.revenue_2021_usd_mn != null) fin.push(`Rev 2021: $${company.revenue_2021_usd_mn}M`);
  if (company.revenue_2022_usd_mn != null) fin.push(`Rev 2022: $${company.revenue_2022_usd_mn}M`);
  if (company.revenue_2023_usd_mn != null) fin.push(`Rev 2023: $${company.revenue_2023_usd_mn}M`);
  if (company.revenue_2024_usd_mn != null) fin.push(`Rev 2024: $${company.revenue_2024_usd_mn}M`);
  if (company.ebitda_2021_usd_mn != null) fin.push(`EBITDA 2021: $${company.ebitda_2021_usd_mn}M`);
  if (company.ebitda_2022_usd_mn != null) fin.push(`EBITDA 2022: $${company.ebitda_2022_usd_mn}M`);
  if (company.ebitda_2023_usd_mn != null) fin.push(`EBITDA 2023: $${company.ebitda_2023_usd_mn}M`);
  if (company.ebitda_2024_usd_mn != null) fin.push(`EBITDA 2024: $${company.ebitda_2024_usd_mn}M`);
  if (company.ev_2024 != null) fin.push(`EV 2024: $${company.ev_2024}M`);
  if (company.ebitda_margin_2024 != null) fin.push(`EBITDA Margin 2024: ${(company.ebitda_margin_2024 * 100).toFixed(1)}%`);
  if (fin.length > 0) lines.push(`Financials: ${fin.join(' | ')}`);

  if (company.l1_screening_result) lines.push(`L1 Result: ${company.l1_screening_result}`);

  if (analysis) {
    if (analysis.business_overview) lines.push(`\nBusiness Overview:\n${analysis.business_overview}`);
    if (analysis.business_model_summary) lines.push(`\nBusiness Model:\n${analysis.business_model_summary}`);
    if (analysis.key_takeaways) lines.push(`\nKey Takeaways:\n${analysis.key_takeaways}`);
    if (analysis.investment_highlights) lines.push(`\nInvestment Highlights:\n${analysis.investment_highlights}`);
    if (analysis.investment_risks) lines.push(`\nInvestment Risks:\n${analysis.investment_risks}`);
    if (analysis.diligence_priorities) lines.push(`\nDiligence Priorities:\n${analysis.diligence_priorities}`);

    if (analysis.sources && analysis.sources.length > 0) {
      lines.push(`\nAvailable Sources for Citations (USE THESE URLs in slide citation footers):`);
      for (const src of analysis.sources) {
        if (src.url) {
          lines.push(`- ${src.title || src.type}: ${src.url}`);
        } else {
          lines.push(`- ${src.title || src.type}`);
        }
      }
    }
  }

  // Always include the company website as a citation source if available
  if (company.website) {
    lines.push(`\nCompany Website URL for citations: ${company.website}`);
  }

  return lines.join('\n');
}

function blankSlideHtml(title: string): string {
  return `<div style="display:flex;align-items:center;justify-content:center;width:1120px;height:630px;overflow:hidden;background:#f8fafc;font-family:Inter,system-ui,sans-serif;">
  <div style="text-align:center;">
    <h1 style="font-size:28px;font-weight:700;color:#1e3a5f;margin-bottom:8px;">${title}</h1>
    <p style="font-size:14px;color:#94a3b8;">Use the prompt below to generate content for this slide</p>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Slide Canvas (renders HTML in an iframe)
// ---------------------------------------------------------------------------

function SlideCanvas({ html, width = 1120, height = 630, zoom = 1 }: { html: string; width?: number; height?: number; zoom?: number }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: white;
    color: #1e293b;
    transform: scale(${zoom});
    transform-origin: top left;
    pointer-events: none;
  }
  body > div {
    max-width: ${width}px;
    max-height: ${height}px;
    overflow: hidden;
  }
  a { pointer-events: auto; cursor: pointer; }
</style>
</head>
<body>${html}</body>
</html>`);
    doc.close();
  }, [html, width, height, zoom]);

  return (
    <iframe
      ref={iframeRef}
      className="border-0"
      style={{ width: width * zoom, height: height * zoom }}
      title="Slide preview"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    />
  );
}

// ---------------------------------------------------------------------------
// Presentation Mode (fullscreen overlay)
// ---------------------------------------------------------------------------

function PresentationMode({
  slides,
  initialSlide,
  onClose,
}: {
  slides: SlideRow[];
  initialSlide: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(initialSlide);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setCurrent((c) => Math.min(c + 1, slides.length - 1));
      else if (e.key === 'ArrowLeft') setCurrent((c) => Math.max(c - 1, 0));
    },
    [onClose, slides.length]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [handleKey]);

  const slide = slides[current];
  if (!slide) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: '#0f172a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 100001,
          background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 8, color: 'white', padding: 8, cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
        title="Close (Esc)"
      >
        <X className="h-5 w-5" />
      </button>

      {slides.length > 1 && (
        <>
          <button
            onClick={() => setCurrent((c) => Math.max(c - 1, 0))}
            disabled={current === 0}
            style={{
              position: 'fixed', left: 16, top: '50%', transform: 'translateY(-50%)',
              zIndex: 100001, background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8,
              color: 'white', padding: '10px 6px',
              cursor: current === 0 ? 'default' : 'pointer',
              opacity: current === 0 ? 0.3 : 1,
            }}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            onClick={() => setCurrent((c) => Math.min(c + 1, slides.length - 1))}
            disabled={current === slides.length - 1}
            style={{
              position: 'fixed', right: 16, top: '50%', transform: 'translateY(-50%)',
              zIndex: 100001, background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8,
              color: 'white', padding: '10px 6px',
              cursor: current === slides.length - 1 ? 'default' : 'pointer',
              opacity: current === slides.length - 1 ? 0.3 : 1,
            }}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      <div
        style={{
          width: 1120, height: 630, background: 'white',
          borderRadius: 8, overflow: 'hidden',
          boxShadow: '0 25px 50px rgba(0,0,0,0.4)',
        }}
      >
        <SlideCanvas html={slide.html} />
      </div>

      <div
        style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          color: 'rgba(255,255,255,0.6)', fontSize: 13, fontFamily: 'system-ui, sans-serif',
        }}
      >
        {current + 1} / {slides.length}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function SlidesPage({ showCrm = false, showAiWorkforce = false }: SlidesPageProps) {
  const params = useParams();
  const router = useRouter();
  const companyId = params.dealId as string;

  const [company, setCompany] = useState<CompanyData | null>(null);
  const [analysis, setAnalysis] = useState<CompanyAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  const [slides, setSlides] = useState<SlideRow[]>([]);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [presentationMode, setPresentationMode] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [slideZooms, setSlideZooms] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState(false);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const selectedSlide = slides.find((s) => s.id === selectedSlideId) ?? null;
  const selectedIndex = slides.findIndex((s) => s.id === selectedSlideId);
  const selectedZoom = selectedSlide ? (slideZooms[selectedSlide.id] ?? 100) : 100;

  // -----------------------------------------------------------------------
  // Load company, analysis, and persisted slides
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!companyId) return;
    (async () => {
      setLoading(true);
      try {
        const [companyData, analysisRes, slidesRes] = await Promise.all([
          getCompanies({ id: companyId }),
          fetch(`/api/company-analysis?companyId=${companyId}`),
          fetch(`/api/company-slides?companyId=${companyId}`),
        ]);

        if (companyData) setCompany(companyData as CompanyData);

        if (analysisRes.ok) {
          const a = await analysisRes.json();
          if (a.status === 'completed') setAnalysis(a);
        }

        if (slidesRes.ok) {
          const { slides: rows } = await slidesRes.json();
          if (rows && rows.length > 0) {
            setSlides(rows as SlideRow[]);
            setSelectedSlideId(rows[0].id);
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  // Generate default slides if none exist in DB yet
  useEffect(() => {
    if (loading || !company || slides.length > 0 || initializing) return;
    initializeDefaultSlides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, company, analysis]);

  // -----------------------------------------------------------------------
  // DB helpers
  // -----------------------------------------------------------------------

  async function dbCreateSlide(title: string, html: string, sortOrder: number): Promise<SlideRow | null> {
    try {
      const res = await fetch('/api/company-slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, title, html, sort_order: sortOrder }),
      });
      if (!res.ok) throw new Error('Failed to create slide');
      const { slide } = await res.json();
      return slide as SlideRow;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function dbUpdateSlide(id: string, fields: { title?: string; html?: string; sort_order?: number }) {
    try {
      const res = await fetch('/api/company-slides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      if (!res.ok) throw new Error('Failed to update slide');
      const { slide } = await res.json();
      return slide as SlideRow;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function dbDeleteSlide(id: string) {
    try {
      const res = await fetch(`/api/company-slides?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete slide');
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Initialize default slides
  // -----------------------------------------------------------------------

  const initializeDefaultSlides = async () => {
    if (!company) return;
    setInitializing(true);
    const ctx = buildCompanyContext(company, analysis);

    const defaults: { title: string; instruction: string }[] = [
      {
        title: 'Executive Summary',
        instruction: `Create an Executive Summary slide for "${company.target}". Include: company name as title, key metrics (Revenue, EBITDA, EV, EV/EBITDA multiple) in callout boxes at the top, a brief business description, key investment highlights as bullet points on the left, and key risks on the right. Use the financial data and analysis provided. Make it data-dense and professional.`,
      },
      {
        title: 'Shareholding Structure',
        instruction: `Create a Shareholding Structure slide for "${company.target}". Show the ownership breakdown: who owns the company, percentage stakes of major shareholders, and the type of ownership (${company.ownership || 'Private'}). Use a visual layout with boxes or a pie-chart-style representation using HTML/CSS to show ownership percentages. Include shareholder names, stake percentages, and any known institutional/PE/founder holdings. If exact data is unavailable, infer from ownership type and any context provided. Use a clean professional layout with a summary table.`,
      },
      {
        title: 'Current Company Structure',
        instruction: `Create a Current Company Structure slide for "${company.target}". Show the organizational/corporate hierarchy using HTML/CSS boxes and arrows: parent company, subsidiaries, divisions, and key business units. Include geography (${company.geography || 'N/A'}), segment (${company.segment || 'N/A'}), and any known operational structure. Use boxes connected by lines/arrows to show the corporate tree. If exact structure is unknown, infer a plausible structure from the business overview, segment, and geography.`,
      },
      {
        title: 'Products/Services & Customer Distribution',
        instruction: `Create a Products/Services & Customer Distribution slide for "${company.target}". Split into two sections: LEFT side shows product/service breakdown with categories, descriptions, and revenue contribution estimates; RIGHT side shows customer distribution by segment, geography, or type. Use the company focus (${company.company_focus || 'N/A'}), segment (${company.segment || 'N/A'}), geography (${company.geography || 'N/A'}), and business overview to infer products and customer mix. Use card-based or table layouts. If exact data is unavailable, provide plausible estimates based on the industry and segment.`,
      },
      {
        title: 'Historical Financials',
        instruction: `Create a Historical Financials slide for "${company.target}" that summarizes the company's financial data in a professional table. Include rows for: Revenue (2021-2024), EBITDA (2021-2024), EBITDA Margin (2021-2024), and Enterprise Value (2024). Show year-over-year growth rates where possible. Use the following data — Revenue: ${[company.revenue_2021_usd_mn, company.revenue_2022_usd_mn, company.revenue_2023_usd_mn, company.revenue_2024_usd_mn].map((v, i) => v != null ? `$${v}M (${2021 + i})` : `N/A (${2021 + i})`).join(', ')}; EBITDA: ${[company.ebitda_2021_usd_mn, company.ebitda_2022_usd_mn, company.ebitda_2023_usd_mn, company.ebitda_2024_usd_mn].map((v, i) => v != null ? `$${v}M (${2021 + i})` : `N/A (${2021 + i})`).join(', ')}; EBITDA Margins: ${[company.ebitda_margin_2021, company.ebitda_margin_2022, company.ebitda_margin_2023, company.ebitda_margin_2024].map((v, i) => v != null ? `${(v * 100).toFixed(1)}% (${2021 + i})` : `N/A (${2021 + i})`).join(', ')}; EV 2024: ${company.ev_2024 != null ? `$${company.ev_2024}M` : 'N/A'}. Format as a clean HTML table with alternating row colors, bold headers, and a summary row at the bottom highlighting key ratios like EV/EBITDA and EV/Revenue. Include YoY growth bars or indicators where data permits.`,
      },
      {
        title: 'Indicative Valuation',
        instruction: `Create an Indicative Valuation slide for "${company.target}". Show a valuation summary using multiple methodologies: EV/Revenue multiple, EV/EBITDA multiple, and comparable transaction analysis. Use the available data — EV 2024: ${company.ev_2024 != null ? `$${company.ev_2024}M` : 'N/A'}, Revenue 2024: ${company.revenue_2024_usd_mn != null ? `$${company.revenue_2024_usd_mn}M` : 'N/A'}, EBITDA 2024: ${company.ebitda_2024_usd_mn != null ? `$${company.ebitda_2024_usd_mn}M` : 'N/A'}. Include: implied multiples, a valuation range (low/mid/high) using a football-field-style horizontal bar chart in HTML/CSS, and key assumptions. Show the implied enterprise value range prominently. Use professional M&A valuation formatting.`,
      },
      {
        title: 'Company Overview',
        instruction: `Create a Company Overview slide for "${company.target}". Include: company name and logo placeholder, founding year (if known), headquarters/geography (${company.geography || 'N/A'}), industry/segment (${company.segment || 'N/A'}), ownership (${company.ownership || 'N/A'}), website (${company.website || 'N/A'}), company focus (${company.company_focus || 'N/A'}), number of employees (if known), and a brief description of what the company does. Use a clean two-column layout: left side with key facts in a structured list/table, right side with a business description and market positioning summary. Make it the definitive "at a glance" overview of the company.`,
      },
    ];

    const created: SlideRow[] = [];

    for (let i = 0; i < defaults.length; i++) {
      const def = defaults[i];
      let html = blankSlideHtml(def.title);

      try {
        html = await generateSlideHtml({
          instruction: def.instruction,
          companyContext: ctx,
          slideTitle: def.title,
        });
      } catch { /* use placeholder */ }

      const row = await dbCreateSlide(def.title, html, i);
      if (row) created.push(row);
    }

    setSlides(created);
    if (created.length > 0) setSelectedSlideId(created[0].id);
    setInitializing(false);
  };

  // -----------------------------------------------------------------------
  // Regenerate all slides (delete existing, then re-create)
  // -----------------------------------------------------------------------

  const regenerateSlides = async () => {
    if (!company || initializing) return;

    const confirmed = window.confirm(
      'This will delete all existing slides and regenerate them from scratch. Continue?'
    );
    if (!confirmed) return;

    // Delete all existing slides from DB
    await Promise.all(slides.map((s) => dbDeleteSlide(s.id)));
    setSlides([]);
    setSelectedSlideId(null);

    await initializeDefaultSlides();
    toast.success('Slides regenerated');
  };

  // -----------------------------------------------------------------------
  // Prompt → edit current slide only
  // -----------------------------------------------------------------------

  const handleSend = async () => {
    if (!prompt.trim() || generating || !selectedSlide || !company) return;
    const instruction = prompt.trim();
    setPrompt('');
    const ctx = buildCompanyContext(company, analysis);

    setGenerating(true);
    try {
      const newHtml = await generateSlideHtml({
        instruction,
        currentHtml: selectedSlide.html,
        companyContext: ctx,
        slideTitle: selectedSlide.title,
      });

      // Update local state immediately
      setSlides((prev) =>
        prev.map((s) => (s.id === selectedSlide.id ? { ...s, html: newHtml } : s))
      );

      // Persist to DB
      await dbUpdateSlide(selectedSlide.id, { html: newHtml });
      toast.success('Slide updated');
    } catch {
      toast.error('Failed to update slide');
    } finally {
      setGenerating(false);
    }
  };

  // -----------------------------------------------------------------------
  // + button → add a blank slide
  // -----------------------------------------------------------------------

  const addBlankSlide = async () => {
    const title = `Slide ${slides.length + 1}`;
    const html = blankSlideHtml(title);
    const sortOrder = slides.length;

    const row = await dbCreateSlide(title, html, sortOrder);
    if (row) {
      setSlides((prev) => [...prev, row]);
      setSelectedSlideId(row.id);
    } else {
      toast.error('Failed to create slide');
    }
  };

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  const deleteSlide = async (id: string) => {
    const ok = await dbDeleteSlide(id);
    if (!ok) {
      toast.error('Failed to delete slide');
      return;
    }
    setSlides((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (selectedSlideId === id) {
        setSelectedSlideId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
  };

  // -----------------------------------------------------------------------
  // Duplicate
  // -----------------------------------------------------------------------

  const duplicateSlide = async (id: string) => {
    const src = slides.find((s) => s.id === id);
    if (!src) return;
    const sortOrder = slides.length;
    const row = await dbCreateSlide(`${src.title} (copy)`, src.html, sortOrder);
    if (row) {
      const idx = slides.findIndex((s) => s.id === id);
      setSlides((prev) => [...prev.slice(0, idx + 1), row, ...prev.slice(idx + 1)]);
      setSelectedSlideId(row.id);
    }
  };

  // -----------------------------------------------------------------------
  // Rearrange (move slide up/down)
  // -----------------------------------------------------------------------

  const moveSlide = async (id: string, direction: 'up' | 'down') => {
    const idx = slides.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= slides.length) return;

    const newSlides = [...slides];
    [newSlides[idx], newSlides[targetIdx]] = [newSlides[targetIdx], newSlides[idx]];
    setSlides(newSlides);

    await Promise.all([
      dbUpdateSlide(newSlides[idx].id, { sort_order: idx }),
      dbUpdateSlide(newSlides[targetIdx].id, { sort_order: targetIdx }),
    ]);
  };

  // -----------------------------------------------------------------------
  // Rename
  // -----------------------------------------------------------------------

  const startEditTitle = (id: string) => {
    const s = slides.find((sl) => sl.id === id);
    if (s) {
      setEditingTitle(id);
      setTitleDraft(s.title);
    }
  };

  const commitTitle = async () => {
    if (!editingTitle) return;
    const newTitle = titleDraft.trim() || slides.find((s) => s.id === editingTitle)?.title || 'Untitled';
    setSlides((prev) =>
      prev.map((s) => (s.id === editingTitle ? { ...s, title: newTitle } : s))
    );
    await dbUpdateSlide(editingTitle, { title: newTitle });
    setEditingTitle(null);
  };

  // -----------------------------------------------------------------------
  // Export PPTX
  // -----------------------------------------------------------------------

  const handleExportPptx = async () => {
    if (slides.length === 0 || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/slides/export-pptx?companyId=${companyId}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${company?.target ?? 'slides'}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('PPTX exported');
    } catch {
      toast.error('Failed to export PPTX');
    } finally {
      setExporting(false);
    }
  };

  // -----------------------------------------------------------------------
  // Keyboard
  // -----------------------------------------------------------------------

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!company) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted-foreground">Company not found</p>
          <Button onClick={() => router.push('/pipeline')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="flex flex-col h-[calc(100vh-0px)]">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-background/80 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push(`/pipeline/${companyId}`)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Presentation className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">{company.target} — Slide Builder</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={regenerateSlides}
              disabled={initializing || slides.length === 0}
              className="gap-2"
            >
              {initializing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Regenerate Slides
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportPptx}
              disabled={slides.length === 0 || exporting}
              className="gap-2"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Export PPTX (Beta)
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPresentationMode(true)}
              disabled={slides.length === 0}
              className="gap-2"
            >
              <Maximize2 className="h-4 w-4" />
              Present
            </Button>
          </div>
        </div>

        {/* Main content: sidebar + canvas */}
        <div className="flex flex-1 min-h-0">
          {/* Left sidebar: slide thumbnails */}
          <div className="w-64 border-r bg-muted/30 flex flex-col shrink-0">
            <div className="p-3 border-b flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Slides</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={addBlankSlide}
                title="Add blank slide"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {initializing ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-xs text-muted-foreground text-center">Generating default slides...</p>
                </div>
              ) : slides.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <FileText className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground text-center">No slides yet</p>
                  <Button variant="outline" size="sm" onClick={addBlankSlide} className="gap-1">
                    <Plus className="h-3 w-3" /> Add slide
                  </Button>
                </div>
              ) : (
                slides.map((slide, idx) => (
                  <div
                    key={slide.id}
                    className={`group relative rounded-lg border cursor-pointer transition-all ${
                      selectedSlideId === slide.id
                        ? 'border-primary ring-2 ring-primary/20 bg-background'
                        : 'border-border hover:border-primary/40 bg-background/60'
                    }`}
                    onClick={() => setSelectedSlideId(slide.id)}
                  >
                    {/* Thumbnail */}
                    <div className="relative overflow-hidden rounded-t-lg" style={{ height: 90 }}>
                      <div
                        style={{
                          transform: 'scale(0.2)',
                          transformOrigin: 'top left',
                          width: 1120,
                          height: 630,
                          pointerEvents: 'none',
                        }}
                      >
                        <SlideCanvas html={slide.html} />
                      </div>
                    </div>

                    {/* Title + actions */}
                    <div className="px-2 py-1.5 flex items-center gap-1">
                      <div className="flex flex-col shrink-0 mr-0.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); moveSlide(slide.id, 'up'); }}
                          className="p-0 hover:bg-muted rounded disabled:opacity-20"
                          disabled={idx === 0}
                          title="Move up"
                        >
                          <ChevronUp className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveSlide(slide.id, 'down'); }}
                          className="p-0 hover:bg-muted rounded disabled:opacity-20"
                          disabled={idx === slides.length - 1}
                          title="Move down"
                        >
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium w-4 shrink-0">
                        {idx + 1}
                      </span>
                      {editingTitle === slide.id ? (
                        <Input
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={commitTitle}
                          onKeyDown={(e) => e.key === 'Enter' && commitTitle()}
                          className="h-5 text-[11px] px-1 py-0"
                          autoFocus
                        />
                      ) : (
                        <span
                          className="text-[11px] font-medium truncate flex-1"
                          onDoubleClick={() => startEditTitle(slide.id)}
                        >
                          {slide.title}
                        </span>
                      )}
                      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditTitle(slide.id); }}
                          className="p-0.5 hover:bg-muted rounded"
                          title="Rename"
                        >
                          <Pencil className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); duplicateSlide(slide.id); }}
                          className="p-0.5 hover:bg-muted rounded"
                          title="Duplicate"
                        >
                          <Copy className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteSlide(slide.id); }}
                          className="p-0.5 hover:bg-destructive/10 rounded"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Center: slide canvas + prompt */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Canvas area */}
            <div className="flex-1 flex flex-col bg-muted/20 overflow-hidden">
              {selectedSlide ? (
                <>
                  {/* Zoom controls */}
                  <div className="flex items-center justify-center gap-3 px-4 py-2 border-b bg-background/60 backdrop-blur-sm shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setSlideZooms((prev) => ({ ...prev, [selectedSlide.id]: Math.max(30, (prev[selectedSlide.id] ?? 100) - 10) }))}
                      title="Zoom out"
                    >
                      <ZoomOut className="h-4 w-4" />
                    </Button>
                    <div className="w-32">
                      <Slider
                        value={[selectedZoom]}
                        min={30}
                        max={150}
                        step={5}
                        onValueChange={([v]) => setSlideZooms((prev) => ({ ...prev, [selectedSlide.id]: v }))}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setSlideZooms((prev) => ({ ...prev, [selectedSlide.id]: Math.min(150, (prev[selectedSlide.id] ?? 100) + 10) }))}
                      title="Zoom in"
                    >
                      <ZoomIn className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">{selectedZoom}%</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setSlideZooms((prev) => ({ ...prev, [selectedSlide.id]: 100 }))}
                    >
                      Reset
                    </Button>
                  </div>
                  <div className="flex-1 overflow-auto relative">
                    {generating && (
                      <div className="absolute inset-x-0 top-4 z-10 flex justify-center pointer-events-none">
                        <div className="flex items-center gap-2.5 px-5 py-2.5 rounded-full bg-primary text-primary-foreground shadow-lg animate-pulse pointer-events-auto">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="text-sm font-medium">AI is editing this slide — content will update shortly</span>
                        </div>
                      </div>
                    )}
                    <div className="min-h-full flex items-center p-4" style={{ minWidth: 'fit-content' }}>
                      <div
                        className={`bg-white rounded-lg shadow-xl overflow-hidden transition-opacity duration-300 ${generating ? 'opacity-50' : ''}`}
                        style={{
                          width: 1120 * (selectedZoom / 100),
                          height: 630 * (selectedZoom / 100),
                          margin: '0 auto',
                        }}
                      >
                        <SlideCanvas html={selectedSlide.html} zoom={selectedZoom / 100} />
                      </div>
                    </div>
                  </div>
                </>
              ) : initializing ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-4">
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                  <p className="text-muted-foreground">Generating your presentation...</p>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
                  <Presentation className="h-16 w-16 text-muted-foreground/30" />
                  <div>
                    <p className="text-lg font-medium text-muted-foreground">No slide selected</p>
                    <p className="text-sm text-muted-foreground/70 mt-1">
                      Select a slide from the sidebar or add a new one
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Prompt bar — only active when a slide is selected */}
            <div className="border-t bg-background px-4 py-3 shrink-0">
              <div className="flex items-end gap-2 max-w-4xl mx-auto">
                <div className="flex-1 relative">
                  <Textarea
                    ref={promptRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={
                      selectedSlide
                        ? `Edit "${selectedSlide.title}" — e.g. "Add a revenue growth chart", "Make the header blue"...`
                        : 'Select a slide to edit it with natural language'
                    }
                    className="min-h-[44px] max-h-[120px] pr-12 resize-none text-sm"
                    rows={1}
                    disabled={generating || !selectedSlide}
                  />
                  <Button
                    size="icon"
                    className="absolute right-1.5 bottom-1.5 h-8 w-8"
                    onClick={handleSend}
                    disabled={!prompt.trim() || generating || !selectedSlide}
                  >
                    {generating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              {selectedSlide && (
                <p className="text-[10px] text-muted-foreground text-center mt-1.5">
                  Editing: {selectedSlide.title} — Type a natural language instruction to modify this slide
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Presentation mode overlay */}
      {presentationMode && (
        <PresentationMode
          slides={slides}
          initialSlide={selectedIndex >= 0 ? selectedIndex : 0}
          onClose={() => setPresentationMode(false)}
        />
      )}
    </DashboardLayout>
  );
}
