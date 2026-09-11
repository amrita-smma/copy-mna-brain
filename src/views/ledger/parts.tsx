'use client';

import type { ReactNode } from 'react';
import { GlossaryTerm } from '@/components/common/GlossaryTerm';
import { LEDGER_GLOSSARY } from './glossary';

export {
  Chevron,
  FIELD_HINT,
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_TEXT,
  FieldKey,
  FlowArrow,
  LedgerBadge as Badge,
  Party,
  signClass,
  SnakeCase,
  StatusDot,
} from '@/components/ledger/LedgerPrimitives';

/** A dotted term defined in the ledger's own glossary. */
export function Term({
  k,
  children,
  className,
}: {
  k: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <GlossaryTerm entry={LEDGER_GLOSSARY[k]} className={className}>
      {children}
    </GlossaryTerm>
  );
}

