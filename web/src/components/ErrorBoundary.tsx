import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error so one broken page does not blank the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which is why a single bad property access turns the window white rather than
 * spoiling one card. A boundary around the routed page keeps the shell — and
 * so the navigation out of it — alive.
 *
 * This has to be a class: `componentDidCatch` and `getDerivedStateFromError`
 * have no hook equivalent.
 */

interface Props {
  children: ReactNode;
  /**
   * Clears the error when it changes — pass the current path.
   *
   * Without this the boundary holds its failed state for as long as it stays
   * mounted, so the user would click away to another page and still be looking
   * at the error from the last one.
   */
  resetKey?: string;
  /** `page` keeps the surrounding layout; `app` has no layout left to keep. */
  variant?: 'page' | 'app';
}

interface State {
  error: Error | null;
  stack: string | null;
  lastResetKey: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, lastResetKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.lastResetKey === undefined) return { lastResetKey: props.resetKey };
    if (props.resetKey !== state.lastResetKey) {
      // Navigated somewhere else: the previous page's failure is no longer
      // what the user is looking at.
      return { error: null, stack: null, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null });
    // Still write it to the console — the boundary changes what the user sees,
    // not what a developer needs in order to fix it.
    // eslint-disable-next-line no-console
    console.error('[ui] render failed', error, info.componentStack);
  }

  private readonly retry = () => {
    this.setState({ error: null, stack: null });
  };

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const isApp = this.props.variant === 'app';

    const panel = (
      <div className="card mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold text-slate-900">
          {isApp ? 'The application could not be displayed' : 'This page could not be displayed'}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Something went wrong while drawing
          {isApp ? ' the application' : ' this page'}. Your data has not been changed.
          {!isApp && ' Try again, or pick another page from the menu.'}
        </p>

        {/*
          The message is shown rather than hidden behind a generic apology: the
          people using this are school staff who will be reporting it to
          whoever maintains the installation, and "TypeError: x.map is not a
          function" is the whole of a useful report.
        */}
        <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700">
          {error.message || String(error)}
        </p>

        {/* The component stack is for development; it means nothing to a user. */}
        {import.meta.env.DEV && stack && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-500">Component stack</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
              {stack}
            </pre>
          </details>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {!isApp && (
            <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={this.retry}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
        </div>
      </div>
    );

    // With no layout left, the fallback has to supply its own page.
    if (isApp) {
      return <div className="min-h-screen bg-slate-50 px-4 py-16">{panel}</div>;
    }
    return panel;
  }
}
