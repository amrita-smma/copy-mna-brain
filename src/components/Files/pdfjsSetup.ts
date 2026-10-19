import { pdfjs } from 'react-pdf';

// Bundler-resolved worker asset (Turbopack/Webpack statically detect this
// `new URL(..., import.meta.url)` pattern) instead of pointing at a CDN, so
// the viewer keeps working offline/behind a firewall. Shared by every
// react-pdf viewer so the worker is configured exactly once.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// cMaps are needed to render embedded CJK/complex-script fonts correctly;
// they're not bundled by default to keep the base package small. Only
// fetched by pdfjs when a document actually needs them.
export const PDF_OPTIONS = {
  cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
  cMapPacked: true,
};
