'use client';

import { Fragment, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Printer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { toLocalISODate } from './adapters';
import {
  fmtAmount,
  fmtDpi,
  fmtIrr,
  fmtMoic,
  formatMonthYear,
  formatPeriodEnd,
  quarterEndOnOrBefore,
  type PresentationReport,
  type PresentationTotals,
} from './presentation';

// The report is a printable document, so it keeps fixed paper colours in both
// themes rather than following the app palette.
const NAVY = '#0b1f5c';
/** Section band tints, cycled in group order (amber, blue, rose, grey, green). */
const BAND_COLORS = ['#fdf0d5', '#dbe8f5', '#fbe2d8', '#ececec', '#e2efd9'];

const COLUMNS: { label: string; align: 'left' | 'right'; className?: string }[] = [
  { label: 'No', align: 'left', className: 'w-[3%]' },
  { label: 'Name', align: 'left', className: 'w-[17%]' },
  { label: 'Entry Date', align: 'left', className: 'w-[8%]' },
  { label: 'Maturity Date', align: 'left', className: 'w-[8%]' },
  { label: 'Investment Commitment', align: 'right', className: 'w-[9%]' },
  { label: 'Invested Capital', align: 'right', className: 'w-[8%]' },
  { label: 'Net Distribution', align: 'right', className: 'w-[9%]' },
  { label: 'Unrealized Market Value', align: 'right', className: 'w-[12%]' },
  { label: 'MOIC', align: 'right', className: 'w-[9%]' },
  { label: 'IRR', align: 'right', className: 'w-[9%]' },
  { label: 'DPI', align: 'right', className: 'w-[8%]' },
];

/** Id of the print-only copy of the report, portaled straight under `<body>`. */
const PRINT_ROOT_ID = 'fund-presentation-print';

// Printing the on-screen copy clips it: it sits in a fixed-height dialog with
// its own scroll container. Instead a second copy is portaled under <body>,
// hidden on screen, and is the only thing printed — so the table flows across
// as many pages as it needs, with the header rows repeated on each page.
const PRINT_STYLES = `
#${PRINT_ROOT_ID} { display: none; }
@media print {
  @page { size: A4 landscape; margin: 10mm; }
  html, body {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; font-size: 9pt; }
  #${PRINT_ROOT_ID} * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #${PRINT_ROOT_ID} thead { display: table-header-group; }
  #${PRINT_ROOT_ID} tr { break-inside: avoid; page-break-inside: avoid; }
  #${PRINT_ROOT_ID} tr[data-band] { break-after: avoid; page-break-after: avoid; }
  #${PRINT_ROOT_ID} tr[data-total] { break-before: avoid; page-break-before: avoid; }
}`;

function TotalCells({ total }: { total: PresentationTotals }) {
  return (
    <>
      <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(total.commitment)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(total.invested)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(total.netDistribution)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(total.unrealizedValue)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtMoic(total.moic)}</td>
      <td className="px-2 py-1" />
      <td className="px-2 py-1 text-right tabular-nums">{fmtDpi(total.dpi)}</td>
    </>
  );
}

function ReportDocument({
  report,
  periodEnd,
  currency,
}: {
  report: PresentationReport;
  periodEnd: string;
  currency: string;
}) {
  const columnCount = COLUMNS.length;
  return (
    <>
      <div className="mb-1 border-b border-black pb-1.5">
        <p className="font-bold">Quarterly Valuation Report</p>
        <p className="mt-1">For the period ending {formatPeriodEnd(periodEnd)}</p>
      </div>

      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr style={{ backgroundColor: NAVY }} className="text-white">
            <th colSpan={columnCount} className="px-1 py-1 text-left font-bold uppercase">
              Investment Portfolio
              <span className="ml-2 text-[11px] font-normal normal-case opacity-80">
                ({currency} millions)
              </span>
            </th>
          </tr>
          <tr className="align-bottom">
            {COLUMNS.map((c) => (
              <th
                key={c.label}
                className={cn(
                  'px-2 pb-1 pt-3 font-bold leading-tight',
                  c.align === 'right' ? 'text-right' : 'text-left',
                  c.className,
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.groups.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="py-8 text-center text-neutral-500">
                No assets to present.
              </td>
            </tr>
          )}
          {report.groups.map((g, gi) => (
            <Fragment key={g.name}>
              {gi > 0 && (
                <tr aria-hidden>
                  <td colSpan={columnCount} className="h-5" />
                </tr>
              )}
              <tr data-band style={{ backgroundColor: BAND_COLORS[gi % BAND_COLORS.length] }}>
                <td className="px-2 py-1" />
                <td colSpan={columnCount - 1} className="px-2 py-1 font-bold">
                  {g.name}
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-2 py-1">{r.no}</td>
                  <td className="break-words px-2 py-1">
                    {r.name}
                  </td>
                  <td className="px-2 py-1">{formatMonthYear(r.entryDate)}</td>
                  <td className="px-2 py-1">{formatMonthYear(r.maturityDate)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(r.commitment)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(r.invested)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(r.netDistribution)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtAmount(r.unrealizedValue)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtMoic(r.moic)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtIrr(r.irr)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtDpi(r.dpi)}</td>
                </tr>
              ))}
              <tr data-total className="border-y-2 border-black font-bold">
                <td className="px-2 py-1" />
                <td colSpan={3} className="px-2 py-1">
                  Total
                </td>
                <TotalCells total={g.total} />
              </tr>
            </Fragment>
          ))}
          {report.groups.length > 0 && (
            <tr data-total style={{ backgroundColor: NAVY }} className="font-bold text-white">
              <td className="px-2 py-1" />
              <td colSpan={3} className="px-2 py-1">
                Grand Total
              </td>
              <TotalCells total={report.grandTotal} />
            </tr>
          )}
        </tbody>
      </table>

      {report.latestValuationDate && (
        <p className="mt-2 text-[11px] italic">
          Updated based on the latest information available for period ending{' '}
          {formatPeriodEnd(report.latestValuationDate)}
        </p>
      )}
    </>
  );
}

export function PresentationDialog({
  open,
  onOpenChange,
  report,
  asOfDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: PresentationReport;
  /** The portfolio's as-of date (ISO); empty means the live portfolio. */
  asOfDate: string;
}) {
  const currency = useWorkspaceCurrency();
  const reportRef = useRef<HTMLDivElement>(null);
  const periodEnd = useMemo(
    () => asOfDate || quarterEndOnOrBefore(toLocalISODate(new Date())),
    [asOfDate],
  );
  const enterFullscreen = () => {
    reportRef.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] max-w-[min(1500px,96vw)] flex-col gap-0 overflow-hidden p-0">
        {typeof document !== 'undefined' &&
          createPortal(
            <div id={PRINT_ROOT_ID} className="bg-white px-8 py-7 text-black">
              {/* Styles live inside the print root so they still apply when every
                  other direct `body` child is `display: none` in @media print. */}
              <style>{PRINT_STYLES}</style>
              <ReportDocument report={report} periodEnd={periodEnd} currency={currency} />
            </div>,
            document.body,
          )}
        <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5 pr-12">
          <DialogTitle className="text-sm font-medium">Portfolio presentation</DialogTitle>
          <DialogDescription className="sr-only">
            Quarterly valuation report of the portfolio, grouped by investment type.
          </DialogDescription>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={enterFullscreen}>
              <Maximize2 className="h-3.5 w-3.5" />
              Full screen
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.print()}>
              <Printer className="h-3.5 w-3.5" />
              Print / PDF
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-muted p-4">
          <div ref={reportRef} className="mx-auto min-w-[1100px] overflow-auto bg-white px-8 py-7 text-[13px] text-black">
            <ReportDocument report={report} periodEnd={periodEnd} currency={currency} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
