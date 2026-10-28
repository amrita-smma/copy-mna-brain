/**
 * Workspace PowerPoint templates (server-only — reads brand assets off disk).
 *
 * A workspace picks one in the admin portal (`workspaces.pptx_template`). The
 * Pipeline "Present" download (`@/lib/pptx/pipelinePresentationPptx`) puts its
 * slides on the chosen template's master: the logo, page tab and
 * confidentiality line from the template's content layout, redrawn with
 * pptxgenjs.
 *
 * The `'default'` template is represented as `null`: plain slides, no master.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PptxTemplateId } from './catalog';

export * from './catalog';

/**
 * Brand assets live next to this module rather than under `public/`, so they
 * are not publicly downloadable. `fs` reads are invisible to the output
 * tracer, so `next.config.ts` pins this directory into the `/api/**`
 * functions via `outputFileTracingIncludes`.
 */
const ASSET_DIR = path.join(process.cwd(), 'src', 'lib', 'pptx', 'templates', 'assets');

/** An image painted on every slide by the master (inches). */
export interface TemplateMasterImage {
  kind: 'image';
  file: string;
  x: number; y: number; w: number; h: number;
}

/** A fixed text line painted on every slide by the master (inches). */
export interface TemplateMasterText {
  kind: 'text';
  text: string;
  x: number; y: number; w: number; h: number;
  fontFace: string;
  fontSize: number;
  color: string;
  bold?: boolean;
  align: 'left' | 'center' | 'right';
}

export interface PptxTemplate {
  id: Exclude<PptxTemplateId, 'default'>;
  label: string;
  /** The branded master, measured from the template's content layout. */
  master: {
    background: string;
    objects: ReadonlyArray<TemplateMasterImage | TemplateMasterText>;
    slideNumber: {
      x: number; y: number; w: number; h: number;
      color: string;
      fontFace: string;
      fontSize: number;
    };
  };
}

const STARCAPITAL: PptxTemplate = {
  id: 'starcapital',
  label: 'StarCapital',
  master: {
    background: 'FFFFFF',
    objects: [
      { kind: 'image', file: 'starcapital/logo.png', x: 11.51, y: 0.15, w: 1.66, h: 0.69 },
      { kind: 'image', file: 'starcapital/page-tab.png', x: 10.49, y: 6.95, w: 2.84, h: 0.4 },
      {
        kind: 'text',
        text: 'STRICTLY PRIVATE AND CONFIDENTIAL',
        x: 4.36, y: 7.12, w: 4.61, h: 0.22,
        fontFace: 'Arial',
        fontSize: 6,
        color: '054068',
        bold: true,
        align: 'center',
      },
    ],
    slideNumber: { x: 12.2, y: 6.95, w: 0.85, h: 0.4, color: 'FFFFFF', fontFace: 'Arial', fontSize: 8 },
  },
};

const TEMPLATES: Record<PptxTemplate['id'], PptxTemplate> = {
  starcapital: STARCAPITAL,
};

/** The template definition for an id; `null` for the default (plain) slides. */
export function getPptxTemplate(id: PptxTemplateId): PptxTemplate | null {
  return id === 'default' ? null : TEMPLATES[id];
}

/** An asset as the `image/png;base64,…` data string pptxgenjs accepts. */
export function templateAssetDataUri(file: string): string {
  return `image/png;base64,${fs.readFileSync(path.join(ASSET_DIR, file)).toString('base64')}`;
}
