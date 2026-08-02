import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { openUserFeedback } from "@/lib/sentry";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  eventId: string | null;
};

/**
 * Catches render-time crashes so a thrown error shows a readable message
 * instead of silently unmounting the tree to a blank white window.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, eventId: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Render crash:", error, info.componentStack);
    const eventId = Sentry.captureException(error, {
      extra: { componentStack: info.componentStack },
    });
    this.setState({ eventId });
  }

  render() {
    const { error, eventId } = this.state;

    if (!error) return this.props.children;

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary p-8 text-center text-white">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <pre className="max-w-lg overflow-auto whitespace-pre-wrap text-sm text-white/80">
          {error.message}
        </pre>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {eventId ? (
            <button
              className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium text-white hover:bg-white/25"
              onClick={() => {
                void openUserFeedback({ associatedEventId: eventId });
              }}
            >
              Report this problem
            </button>
          ) : null}
          <button
            className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium text-white hover:bg-white/25"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
