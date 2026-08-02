import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fullName, isoDate } from '../lib/format';
import { Card, EmptyState, ErrorNote, PageHeader, Spinner, TableWrap } from '../components/ui';
import type { AttendanceStatus, RegisterRow, SchoolClass } from '../lib/types';

const STATUSES: Array<{ value: AttendanceStatus; label: string; tone: string }> = [
  { value: 'PRESENT', label: 'Present', tone: 'bg-emerald-600' },
  { value: 'ABSENT', label: 'Absent', tone: 'bg-red-600' },
  { value: 'LATE', label: 'Late', tone: 'bg-amber-500' },
  { value: 'EXCUSED', label: 'Excused', tone: 'bg-sky-600' },
  { value: 'SICK', label: 'Sick', tone: 'bg-violet-600' },
];

export function AttendancePage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [day, setDay] = useState(isoDate());
  const [classId, setClassId] = useState('');
  const [streamId, setStreamId] = useState('');
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [notify, setNotify] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });

  const streams = classes.data?.data.find((c) => c.id === classId)?.streams ?? [];

  const registerQuery = qs({ date: day, classId, streamId });
  const register = useQuery({
    queryKey: ['attendance', 'register', registerQuery],
    queryFn: () =>
      get<{ date: string; total: number; data: RegisterRow[] }>(`/attendance/register${registerQuery}`),
    enabled: Boolean(classId || streamId),
  });

  // Pre-fill from whatever is already recorded for the day.
  useEffect(() => {
    if (!register.data) return;
    const existing: Record<string, AttendanceStatus> = {};
    for (const row of register.data.data) {
      if (row.attendance) existing[row.id] = row.attendance.status;
    }
    setMarks(existing);
    setSaved(null);
  }, [register.data]);

  const save = useMutation({
    mutationFn: () =>
      post<{ recorded: number; guardiansNotified: number }>('/attendance', {
        date: day,
        streamId: streamId || null,
        notifyGuardians: notify,
        records: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setSaved(
        `Register saved for ${result.recorded} student(s)` +
          (result.guardiansNotified ? ` · ${result.guardiansNotified} guardian SMS queued` : ''),
      );
    },
  });

  const rows = register.data?.data ?? [];
  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const status of Object.values(marks)) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, [marks]);

  const markAll = (status: AttendanceStatus) => {
    setMarks(Object.fromEntries(rows.map((r) => [r.id, status])));
  };

  const unmarked = rows.length - Object.keys(marks).length;

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Take the daily class register and notify guardians of absences"
      />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="att-date">
              Date
            </label>
            <input
              id="att-date"
              type="date"
              className="input"
              value={day}
              max={isoDate()}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="att-class">
              Class
            </label>
            <select
              id="att-class"
              className="input"
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setStreamId('');
              }}
            >
              <option value="">Select a class</option>
              {classes.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="att-stream">
              Stream
            </label>
            <select
              id="att-stream"
              className="input"
              value={streamId}
              onChange={(e) => setStreamId(e.target.value)}
              disabled={!classId}
            >
              <option value="">Whole class</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-secondary w-full"
              disabled={rows.length === 0}
              onClick={() => markAll('PRESENT')}
            >
              Mark all present
            </button>
          </div>
        </div>
      </Card>

      {!classId && !streamId ? (
        <Card>
          <EmptyState
            title="Choose a class to begin"
            hint="Select the date and class above to load the register."
          />
        </Card>
      ) : register.isLoading ? (
        <Spinner label="Loading register…" />
      ) : register.error ? (
        <ErrorNote error={register.error} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title="No active students in this class" />
        </Card>
      ) : (
        <>
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
              <div className="flex flex-wrap gap-2 text-xs">
                {STATUSES.map((s) => (
                  <span key={s.value} className="rounded-md bg-slate-100 px-2 py-1 text-slate-700">
                    {s.label}: <strong>{summary[s.value] ?? 0}</strong>
                  </span>
                ))}
                {unmarked > 0 && (
                  <span className="rounded-md bg-amber-100 px-2 py-1 text-amber-800">
                    Unmarked: <strong>{unmarked}</strong>
                  </span>
                )}
              </div>
              {can('attendance:record') && (
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={notify}
                      onChange={(e) => setNotify(e.target.checked)}
                    />
                    SMS guardians of absentees
                  </label>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={save.isPending || Object.keys(marks).length === 0}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? 'Saving…' : 'Save register'}
                  </button>
                </div>
              )}
            </div>

            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-16">#</th>
                    <th>Student</th>
                    <th>Admission No</th>
                    <th>Attendance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id}>
                      <td className="text-slate-400">{index + 1}</td>
                      <td className="font-medium text-slate-900">{fullName(row)}</td>
                      <td className="font-mono text-xs">{row.admissionNumber}</td>
                      <td>
                        <div
                          className="flex flex-wrap gap-1"
                          role="radiogroup"
                          aria-label={`Attendance for ${fullName(row)}`}
                        >
                          {STATUSES.map((s) => {
                            const active = marks[row.id] === s.value;
                            return (
                              <button
                                key={s.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={!can('attendance:record')}
                                onClick={() =>
                                  setMarks((prev) => ({ ...prev, [row.id]: s.value }))
                                }
                                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                  active
                                    ? `${s.tone} text-white`
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                }`}
                              >
                                {s.label}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </>
      )}
    </>
  );
}
