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
import { Check, Search } from 'lucide-react';
import FileKindIcon from '@/components/Files/FileKindIcon';

export interface ExistingAttachmentOption {
  id: string;
  /** Display label — a file name, or a link's title / URL. */
  file_name: string;
  /** A YouTube link rather than an uploaded file — drives the row icon. */
  youtube?: boolean;
}

interface ExistingAttachmentPickerProps {
  /** Candidate attachments to search — the caller filters these to featurable kinds. */
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
  emptyText = 'No featurable attachments yet.',
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
                  <FileKindIcon fileName={d.file_name} youtube={d.youtube} className="mr-2" />
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
