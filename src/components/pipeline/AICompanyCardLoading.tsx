import { Loader2, Sparkles, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

interface AICompanyCardLoadingProps {
  onCancel?: () => void;
  cancelling?: boolean;
}

export function AICompanyCardLoading({
  onCancel,
  cancelling = false,
}: AICompanyCardLoadingProps = {}) {
  return (
    <div className="rounded-lg border-2 border-accent/50 bg-accent/10 p-6 space-y-6 relative overflow-hidden">
      {/* Animated gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-accent/20 to-transparent animate-pulse" />

      {/* Header with prominent loading indicator */}
      <div className="relative flex items-center justify-center gap-3 py-8">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-accent/20 border-2 border-accent">
              <Loader2 className="h-8 w-8 animate-spin text-accent" />
            </div>
          </div>
          <div className="text-center space-y-2">
            <div className="flex items-center gap-2 justify-center">
              <Sparkles className="h-5 w-5 text-accent animate-pulse" />
              <h3 className="text-lg font-semibold text-accent">Generating AI Company Card</h3>
              <Sparkles className="h-5 w-5 text-accent animate-pulse" />
            </div>
            <p className="text-sm text-muted-foreground max-w-md">
              Synthesizing insights from multiple data sources to build a comprehensive investment profile.
            </p>
            <div className="flex items-center justify-center gap-1 mt-3">
              <span className="h-2 w-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="h-2 w-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="h-2 w-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            {onCancel && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4 gap-1.5"
                onClick={onCancel}
                disabled={cancelling}
              >
                {cancelling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Skeleton sections */}
      <div className="relative space-y-4 opacity-50">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-3 w-48" />
            <div className="space-y-2 pt-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
