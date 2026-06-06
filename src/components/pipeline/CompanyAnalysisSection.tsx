'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { LucideIcon } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

type ColorVariant = 'default' | 'blue' | 'green' | 'amber' | 'rose' | 'teal';

const colorVariants: Record<ColorVariant, { border: string; icon: string; title: string }> = {
  default: {
    border: '',
    icon: 'text-muted-foreground',
    title: '',
  },
  blue: {
    border: 'border-primary/30',
    icon: 'text-primary',
    title: 'text-primary',
  },
  green: {
    border: 'border-success/30',
    icon: 'text-success',
    title: 'text-success',
  },
  amber: {
    border: 'border-warning/30',
    icon: 'text-warning',
    title: 'text-warning',
  },
  rose: {
    border: 'border-destructive/30',
    icon: 'text-destructive',
    title: 'text-destructive',
  },
  teal: {
    border: 'border-[hsl(173,80%,40%)]/30',
    icon: 'text-[hsl(173,80%,40%)]',
    title: 'text-[hsl(173,80%,40%)]',
  },
};

interface CompanyAnalysisSectionProps {
  title: string;
  description: string;
  icon: LucideIcon;
  content: string;
  placeholder?: string;
  colorVariant?: ColorVariant;
}

export function CompanyAnalysisSection({
  title,
  description,
  icon: Icon,
  content,
  colorVariant = 'default',
}: CompanyAnalysisSectionProps) {
  const colors = colorVariants[colorVariant];
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Card className={colors.border}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <CollapsibleTrigger asChild>
              <div className="flex-1 cursor-pointer group">
                <CardTitle className={`text-base flex items-center gap-2 ${colors.title}`}>
                  <Icon className={`h-4 w-4 ${colors.icon}`} />
                  {title}
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">{description}</p>
              </div>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            {content ? (
              <MarkdownRenderer content={content} variant="card" />
            ) : (
              <p className="text-sm text-muted-foreground italic">
                No content available
              </p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
