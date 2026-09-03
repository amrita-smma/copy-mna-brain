'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Search, X } from 'lucide-react';
import type { FilterOptions } from '@/lib/api/dataNavigator';

const CATEGORY_LABELS: Record<string, string> = {
  expert_insights: 'Expert Insights',
  market_assessment: 'Market Assessment',
  new_funding: 'New Funding',
  ma_partnerships: 'M&A / Partnerships',
  industry_reports: 'Industry Reports',
};

export interface FilterState {
  categories: string[];
  regions: string[];
  query: string;
  selectedOnly: boolean;
}

interface FilterBarProps {
  options: FilterOptions | null;
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function FilterBar({ options, value, onChange }: FilterBarProps) {
  const categories = options?.categories ?? Object.keys(CATEGORY_LABELS);

  function toggleCategory(category: string) {
    const next = value.categories.includes(category)
      ? value.categories.filter((c) => c !== category)
      : [...value.categories, category];
    onChange({ ...value, categories: next });
  }

  const hasFilters =
    value.categories.length > 0 || value.regions.length > 0 || value.query.length > 0;

  return (
    <div className="space-y-3 border-b p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          placeholder="Search headlines, authors, or ask a question…"
          className="pl-8"
          aria-label="Search news"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {categories.map((category) => {
          const active = value.categories.includes(category);
          return (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted',
              )}
            >
              {CATEGORY_LABELS[category] ?? category}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id="curated-only"
            checked={value.selectedOnly}
            onCheckedChange={(checked) => onChange({ ...value, selectedOnly: checked })}
          />
          <Label htmlFor="curated-only" className="text-xs text-muted-foreground">
            Curated picks only
          </Label>
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({ categories: [], regions: [], query: '', selectedOnly: value.selectedOnly })
            }
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

export { CATEGORY_LABELS };
