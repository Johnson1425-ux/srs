import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

/**
 * A child's results, opened from the link in a parent's text message.
 *
 * No sign-in, no navigation, no application shell: whoever opens this arrived
 * from an SMS on a phone, very possibly on a slow connection and paying for the
 * data, so the page is one screen of what they were told to expect and nothing
 * else. It deliberately does not link into the rest of the system — there is
 * nothing here for them to sign in to.
 */

interface PublicResult {
  school: { name: string; logoUrl: string | null; motto: string | null };
  exam: { name: string; term: string | null; academicYear: string; className: string | null };
  student: { name: string; className: string | null; streamName: string | null };
  subjects: Array<{
    subject: string;
    score: number | null;
    maxScore: number;
    grade: string | null;
    isAbsent: boolean;
    remark: string | null;
  }>;
  average: number;
  totalScore: number;
  totalMax: number;
  gpa: number | null;
  position: number | null;
  outOf: number | null;
  classAverage: number;
}

const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

type State =
  | { status: 'loading' }
  | { status: 'ready'; result: PublicResult }
  | { status: 'gone' }
  | { status: 'error' };

export function PublicResultPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/public/results/${token}`);
        if (cancelled) return;

        if (res.status === 404) return setState({ status: 'gone' });
        if (!res.ok) return setState({ status: 'error' });

        setState({ status: 'ready', result: (await res.json()) as PublicResult });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'loading') {
    return <Shell>
      <p className="text-center text-sm text-slate-500">Loading results…</p>
    </Shell>;
  }

  if (state.status === 'gone') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-900">This link is no longer active</h1>
        <p className="mt-2 text-sm text-slate-600">
          Results links expire, and a school can withdraw results after publishing them. Please
          contact the school office for your child's report card.
        </p>
      </Shell>
    );
  }

  if (state.status === 'error') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-900">Results could not be loaded</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please check your connection and try again. If it keeps happening, contact the school
          office.
        </p>
      </Shell>
    );
  }

  const { result } = state;

  return (
    <Shell>
      <header className="border-b border-slate-200 pb-4 text-center">
        {result.school.logoUrl && (
          <img
            src={result.school.logoUrl}
            alt=""
            className="mx-auto mb-3 h-14 w-14 rounded object-contain"
          />
        )}
        <h1 className="text-base font-semibold text-slate-900">{result.school.name}</h1>
        {result.school.motto && (
          <p className="mt-1 text-xs italic text-slate-500">{result.school.motto}</p>
        )}
      </header>

      <section className="mt-4">
        <h2 className="text-lg font-semibold text-slate-900">{result.student.name}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {[result.student.className, result.student.streamName].filter(Boolean).join(' ')}
        </p>
        <p className="mt-3 text-sm font-medium text-slate-800">{result.exam.name}</p>
        <p className="text-xs text-slate-500">
          {[result.exam.term, result.exam.academicYear].filter(Boolean).join(' · ')}
        </p>
      </section>

      {/* The three numbers a parent is looking for, before any detail. */}
      <section className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Figure label="Average" value={`${result.average.toFixed(1)}%`} />
        <Figure
          label="Position"
          value={result.position !== null ? `${result.position}${result.outOf ? ` / ${result.outOf}` : ''}` : '—'}
        />
        <Figure label="Class average" value={`${result.classAverage.toFixed(1)}%`} />
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-semibold text-slate-800">Subjects</h3>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="py-2 font-medium">Subject</th>
              <th className="py-2 text-right font-medium">Score</th>
              <th className="py-2 text-right font-medium">Grade</th>
            </tr>
          </thead>
          <tbody>
            {result.subjects.map((s) => (
              <tr key={s.subject} className="border-b border-slate-100">
                <td className="py-2 text-slate-700">{s.subject}</td>
                <td className="py-2 text-right tabular-nums text-slate-700">
                  {s.isAbsent ? 'Absent' : s.score !== null ? `${s.score} / ${s.maxScore}` : '—'}
                </td>
                <td className="py-2 text-right font-medium text-slate-900">{s.grade ?? '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2 font-medium text-slate-800">Total</td>
              <td className="py-2 text-right font-medium tabular-nums text-slate-900">
                {result.totalScore} / {result.totalMax}
              </td>
              <td className="py-2 text-right text-slate-500">
                {result.gpa !== null ? `GPA ${result.gpa.toFixed(2)}` : ''}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p className="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-500">
        Sent to you by {result.school.name}. For a signed report card, or if anything here looks
        wrong, please contact the school office.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-md bg-white px-5 py-8 sm:my-6 sm:rounded-lg sm:shadow">
      {children}
    </main>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-50 px-2 py-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}
