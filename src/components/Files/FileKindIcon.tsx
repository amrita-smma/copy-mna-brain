import { FileText, FileType2, Film, Music, Presentation, Youtube } from 'lucide-react';
import { cn } from '@/lib/utils';
import { detectFileKind } from '@/lib/fileType';

/**
 * The icon for a file (by name) or a YouTube link, coloured by kind: a deck,
 * a PDF, a recording, or anything else. Pass `youtube` for a link row, which
 * has no file name to detect from.
 */
export default function FileKindIcon({
  fileName,
  youtube = false,
  className,
}: {
  fileName?: string;
  youtube?: boolean;
  className?: string;
}) {
  const base = cn('h-4 w-4 shrink-0', className);
  if (youtube) return <Youtube className={cn(base, 'text-red-600')} />;
  switch (detectFileKind(fileName ?? '')) {
    case 'pptx':
      return <Presentation className={cn(base, 'text-orange-500')} />;
    case 'pdf':
      return <FileText className={cn(base, 'text-red-500')} />;
    case 'video':
      return <Film className={cn(base, 'text-violet-500')} />;
    case 'audio':
      return <Music className={cn(base, 'text-sky-500')} />;
    default:
      return <FileType2 className={cn(base, 'text-muted-foreground')} />;
  }
}
