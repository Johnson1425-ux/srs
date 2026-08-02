import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Card, ErrorNote, PageHeader, Spinner, TableWrap } from '../components/ui';

interface MarksSheet {
  exam: { id: string; name: string; status: string };
  subject: { id: string; name: string; code: string };
  maxScore: number;
  data: Array<{
    id: string;
    admissionNumber: string;
    firstName: string;
    lastName: string;
    result: { score: number | null; grade: string | null; isAbsent: boolean } | null;
  }>;
}

interface Entry {
  score: string;
  isAbsent: boolean;
}

export function MarksEntryPage() {
  const { examSubjectId = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const sheet = useQuery({
    queryKey: ['marks', examSubjectId],
    queryFn: () => get<MarksSheet>(`/exams/subjects/${examSubjectId}/marks`),
  });

  useEffect(() => {
    if (!sheet.data) return;
    const initial: Record<string, Entry> = {};
    for (const row of sheet.data.data) {
      initial[row.id] = {
        score: row.result?.score != null ? String(row.result.score) : '',
        isAbsent: row.result?.isAbsent ?? false,
      };
    }
    setEntries(initial);
  }, [sheet.data]);

  const save = useMutation({
    mutationFn: () => {
      const payload = Object.entries(entries)
        // Skip untouched rows so a partially marked paper can be saved.
        .filter(([, entry]) => entry.isAbsent || entry.score !== '')
        .map(([studentId, entry]) => ({
          studentId,
          isAbsent: entry.isAbsent,
          score: entry.isAbsent ? null : Number(entry.score),
        }));
      return post<{ saved: number }>(`/exams/subjects/${examSubjectId}/marks`, { entries: payload });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['marks', examSubjectId] });
      void queryClient.invalidateQueries({ queryKey: ['exams'] });
      setSaved(`Saved marks for ${result.saved} student(s)`);
    },
  });

  if (sheet.isLoading) return <Spinner />;
  if (sheet.error) return <ErrorNote error={sheet.error} />;
  if (!sheet.data) return null;

  const locked = sheet.data.exam.status === 'PUBLISHED' || !can('exams:enter_marks');
  const max = sheet.data.maxScore;
  const entered = Object.values(entries).filter((e) => e.isAbsent || e.score !== '').length;

  return (
    <>
      <PageHeader
        title={`${sheet.data.subject.name} — marks entry`}
        subtitle={sheet.data.exam.name}
        actions={
          <>
            <Link to="/exams" className="btn-secondary">
              Back to exams
            </Link>
            <Link to={`/exams/${sheet.data.exam.id}/results`} className="btn-secondary">
              Result sheet
            </Link>
          </>
        }
      />

      {locked && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {sheet.data.exam.status === 'PUBLISHED'
            ? 'Results are published — marks are read-only. Unpublish the exam to make corrections.'
            : 'You have read-only access to these marks.'}
        </div>
      )}
      {saved && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {saved}
        </div>
      )}
      {save.error != null && (
        <div className="mb-4">
          <ErrorNote error={save.error} />
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <div className="text-sm text-slate-600">
            Marked out of <strong>{max}</strong> · {entered}/{sheet.data.data.length} entered
            <span className="ml-3">
              <Badge status={sheet.data.exam.status} />
            </span>
          </div>
          {!locked && (
            <button
              type="button"
              className="btn-primary"
              disabled={save.isPending || entered === 0}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save marks'}
            </button>
          )}
        </div>

        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th className="w-14">#</th>
                <th>Admission No</th>
                <th>Student</th>
                <th className="w-40">Score</th>
                <th className="w-28">Absent</th>
                <th className="w-24">Grade</th>
              </tr>
            </thead>
            <tbody>
              {sheet.data.data.map((row, index) => {
                const entry = entries[row.id] ?? { score: '', isAbsent: false };
                const invalid = entry.score !== '' && (Number(entry.score) < 0 || Number(entry.score) > max);
                return (
                  <tr key={row.id}>
                    <td className="text-slate-400">{index + 1}</td>
                    <td className="font-mono text-xs">{row.admissionNumber}</td>
                    <td className="font-medium text-slate-900">
                      {row.firstName} {row.lastName}
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={max}
                        step="0.5"
                        className={`input ${invalid ? 'border-red-400' : ''}`}
                        value={entry.score}
                        disabled={locked || entry.isAbsent}
                        aria-label={`Score for ${row.firstName} ${row.lastName}`}
                        aria-invalid={invalid}
                        onChange={(e) =>
                          setEntries((prev) => ({
                            ...prev,
                            [row.id]: { ...entry, score: e.target.value },
                          }))
                        }
                      />
                      {invalid && <p className="field-error">Must be between 0 and {max}</p>}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={entry.isAbsent}
                        disabled={locked}
                        aria-label={`Mark ${row.firstName} ${row.lastName} absent`}
                        onChange={(e) =>
                          setEntries((prev) => ({
                            ...prev,
                            [row.id]: { score: e.target.checked ? '' : entry.score, isAbsent: e.target.checked },
                          }))
                        }
                      />
                    </td>
                    <td className="font-medium">
                      {row.result?.isAbsent ? '—' : (row.result?.grade ?? '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <p className="mt-4 text-xs text-slate-500">
        Grades and GPA points are calculated from the school grading scale when marks are saved.
      </p>
    </>
  );
}
