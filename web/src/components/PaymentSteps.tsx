import { type CSSProperties, useEffect, useState } from 'react';

/**
 * The progress a school sees while a registration payment is being processed.
 *
 * A mobile money payment is a conversation with somebody holding a handset, so
 * it can sit open for up to two minutes with nothing to report. What this
 * draws is the shape of that wait: which parts are finished, which one is
 * being waited on, and what is still to come. The states come from the payment
 * record itself — nothing here advances on a timer, because a step that ticks
 * itself off would be telling the school something we do not know.
 */
export type StepState = 'done' | 'active' | 'upcoming' | 'failed';

export interface PaymentStep {
  /** Stable across state changes, so a step eases in once and then transitions. */
  key: string;
  label: string;
  /** A line under the label, for the step being waited on. */
  detail?: string;
  state: StepState;
}

const LABEL_CLASS: Record<StepState, string> = {
  done: 'text-sm text-slate-600',
  active: 'step-shimmer text-sm font-medium',
  upcoming: 'text-sm text-slate-400',
  failed: 'text-sm font-medium text-rose-700',
};

export function PaymentSteps({ steps }: { steps: PaymentStep[] }) {
  return (
    <ol aria-label="Payment progress">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li
            key={step.key}
            className={`step-enter relative flex gap-3 ${last ? '' : 'pb-5'}`}
            style={{ animationDelay: `${index * 70}ms` }}
            aria-current={step.state === 'active' ? 'step' : undefined}
          >
            {!last && (
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-[10px] top-6 w-0.5 overflow-hidden rounded bg-slate-200"
              >
                {step.state === 'done' && (
                  <span
                    className="rail-fill block h-full w-full bg-emerald-400"
                    style={{ animationDelay: `${index * 90 + 120}ms` }}
                  />
                )}
              </span>
            )}

            <StepIcon state={step.state} index={index} />

            <div className="min-w-0 pb-0.5">
              <p className={`${LABEL_CLASS[step.state]} transition-colors duration-500`}>
                {step.label}
              </p>
              {step.detail && (
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{step.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The marker beside a step.
 *
 * The tick and the cross draw themselves on the way in: the element only
 * mounts when the step reaches that state, so the drawing happens exactly when
 * the news arrives. `pathLength` normalises each path to 20 units, which is
 * what the dash animation in the stylesheet is written against.
 */
function StepIcon({ state, index }: { state: StepState; index: number }) {
  // A cascade when several steps settle at once, as they do on confirmation.
  const stagger = { animationDelay: `${index * 90}ms` } as CSSProperties;
  const drawn = { animationDelay: `${index * 90 + 80}ms` } as CSSProperties;

  if (state === 'done') {
    return (
      <span
        className="mark-pop relative mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
        style={stagger}
      >
        <svg
          viewBox="0 0 20 20"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 10.4 8.3 13.7 15 6.6" pathLength={20} className="mark-draw" style={drawn} />
        </svg>
      </span>
    );
  }

  if (state === 'failed') {
    return (
      <span
        className="mark-pop relative mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-rose-500 text-white"
        style={stagger}
      >
        <svg
          viewBox="0 0 20 20"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6 14 14" pathLength={20} className="mark-draw" style={drawn} />
          <path
            d="M14 6 6 14"
            pathLength={20}
            className="mark-draw"
            style={{ animationDelay: `${index * 90 + 200}ms` }}
          />
        </svg>
      </span>
    );
  }

  if (state === 'active') {
    return (
      <span className="relative mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center">
        <span className="step-halo absolute inset-0 rounded-full bg-brand-400/40" aria-hidden="true" />
        <span className="step-dot h-2.5 w-2.5 rounded-full bg-brand-600" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full border-2 border-slate-200 transition-colors duration-500"
      aria-hidden="true"
    />
  );
}

/**
 * How long the school has been waiting, and the drifting bar under it.
 *
 * The bar is deliberately indeterminate. The gateway is holding the prompt
 * open for somebody to find their phone and type a PIN, and nobody — the
 * gateway included — knows how far through that is.
 */
export function WaitMeter({
  seconds,
  overdue,
  label,
}: {
  seconds: number;
  overdue: boolean;
  label: string;
}) {
  return (
    <div className="mt-2">
      <div
        className="wait-bar h-1 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label={label}
      >
        <span
          className={`block h-full w-1/3 rounded-full ${overdue ? 'bg-amber-400' : 'bg-brand-500'}`}
        />
      </div>
      <p className="mt-1.5 text-xs text-slate-400">
        {overdue ? 'Still waiting' : 'Waiting'} · {clock(seconds)}
      </p>
    </div>
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Seconds since `startedAt`, ticking only while something is actually open. */
export function useElapsedSeconds(startedAt: number, running: boolean): number {
  const [seconds, setSeconds] = useState(() => elapsed(startedAt));

  useEffect(() => {
    setSeconds(elapsed(startedAt));
    if (!running) return undefined;
    const timer = window.setInterval(() => setSeconds(elapsed(startedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, running]);

  return seconds;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}
