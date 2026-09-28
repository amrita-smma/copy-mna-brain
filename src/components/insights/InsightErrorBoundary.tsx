'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Dependency-free class error boundary wrapping insight documents so
 * a render failure displays cleanly in place instead of blanking the page.
 */
export class InsightErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[InsightErrorBoundary] Render failure caught:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 my-4 rounded-lg border border-destructive bg-card text-card-foreground shadow-sm">
          <div className="flex flex-col gap-2">
            <h3 className="text-lg font-semibold text-destructive">
              Unable to render insight document
            </h3>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ??
                'An error occurred while displaying the insight frame.'}
            </p>
            <div className="mt-2">
              <button
                type="button"
                onClick={this.handleRetry}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
