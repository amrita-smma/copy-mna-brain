'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, FileText, Search } from 'lucide-react';

export interface ExistingAttachmentOption {
  id: string;
  file_name: string;
}

interface ExistingAttachmentPickerProps {
  /** Candidate documents to search — the caller filters these to a presentable kind (PDF/PPTX). */
  documents: ExistingAttachmentOption[];
  /** Fires once with the chosen document's id, then the popover closes. */
  onSelect: (documentId: string) => void;
  /** Currently featured document id, if any — shown with a check mark. */
  selectedId?: string | null;
  disabled?: boolean;
  triggerLabel?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}

/**
 * Searchable picker over a company's existing attachments, used to feature
 * one without re-uploading it. Unlike StatusCombobox/UserSelectCombobox this
 * isn't a bound value display — picking an option just fires `onSelect` once.
 */
export default function ExistingAttachmentPicker({
  documents,
  onSelect,
  selectedId,
  disabled,
  triggerLabel = 'Choose existing',
  searchPlaceholder = 'Search attachments…',
  emptyText = 'No PDF or PPTX attachments yet.',
  className,
}: ExistingAttachmentPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => d.file_name.toLowerCase().includes(q));
  }, [documents, query]);

  const commit = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('gap-1.5', className)}
        >
          <Search className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[320px] p-0"
        align="end"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filtered.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {filtered.map((d) => (
                <CommandItem key={d.id} value={d.id} onSelect={() => commit(d.id)}>
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      selectedId === d.id ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.file_name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
