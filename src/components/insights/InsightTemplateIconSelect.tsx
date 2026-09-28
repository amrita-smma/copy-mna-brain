'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  INSIGHT_TEMPLATE_ICONS,
  isInsightTemplateIcon,
  type InsightTemplateIcon,
} from '@/lib/insights/templateIcons';
import {
  Briefcase,
  Building2,
  FileText,
  Globe,
  LineChart,
  PieChart,
  Scale,
  Shield,
  type LucideIcon,
} from 'lucide-react';

export const ICON_COMPONENTS: Record<InsightTemplateIcon, LucideIcon> = {
  'chart-line': LineChart,
  briefcase: Briefcase,
  scale: Scale,
  'file-text': FileText,
  globe: Globe,
  building: Building2,
  shield: Shield,
  'pie-chart': PieChart,
};

export const ICON_LABELS: Record<InsightTemplateIcon, string> = {
  'chart-line': 'Chart Line',
  briefcase: 'Briefcase',
  scale: 'Scale',
  'file-text': 'File Text',
  globe: 'Globe',
  building: 'Building',
  shield: 'Shield',
  'pie-chart': 'Pie Chart',
};

export function getTemplateIconComponent(
  icon: string | null | undefined,
): LucideIcon {
  return isInsightTemplateIcon(icon) ? ICON_COMPONENTS[icon] : FileText;
}

const NONE = 'none';

export interface InsightTemplateIconSelectProps {
  id: string;
  /** The icon key, or null for the default. */
  value: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
}

/** The template icon picker shared by the upload and edit dialogs. */
export function InsightTemplateIconSelect({
  id,
  value,
  onChange,
  disabled,
}: InsightTemplateIconSelectProps) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="bg-card text-foreground border border-input">
        <SelectValue placeholder="Select an icon" />
      </SelectTrigger>
      <SelectContent className="bg-card text-foreground border border-border shadow-md">
        <SelectItem value={NONE} className="cursor-pointer hover:bg-muted focus:bg-muted">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span>None (default)</span>
          </div>
        </SelectItem>
        {INSIGHT_TEMPLATE_ICONS.map((iconName) => {
          const IconComp = ICON_COMPONENTS[iconName];
          return (
            <SelectItem
              key={iconName}
              value={iconName}
              className="cursor-pointer hover:bg-muted focus:bg-muted"
            >
              <div className="flex items-center gap-2">
                <IconComp className="h-4 w-4 text-muted-foreground" />
                <span>{ICON_LABELS[iconName]}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
