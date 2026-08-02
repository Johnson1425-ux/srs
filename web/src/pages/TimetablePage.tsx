import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../lib/api';
import { Card, EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import type { SchoolClass } from '../lib/types';

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];

interface Slot {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  room: string | null;
  subject: { id: string; name: string; code: string };
  teacher: { id: string; firstName: string; lastName: string } | null;
  schoolClass: { id: string; name: string };
  stream: { id: string; name: string } | null;
}

export function TimetablePage() {
  const [classId, setClassId] = useState('');
  const [streamId, setStreamId] = useState('');

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });
  const streams = classes.data?.data.find((c) => c.id === classId)?.streams ?? [];

  const query = qs({ classId, streamId });
  const timetable = useQuery({
    queryKey: ['timetable', query],
    queryFn: () => get<{ data: Slot[] }>(`/academics/timetable${query}`),
    enabled: Boolean(classId),
  });

  const slots = timetable.data?.data ?? [];
  // Distinct period start times, in chronological order, become the row axis.
  const periods = [...new Set(slots.map((s) => `${s.startTime}-${s.endTime}`))].sort();

  return (
    <>
      <PageHeader title="Timetable" subtitle="Weekly lesson schedule by class and stream" />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="label" htmlFor="tt-class">
              Class
            </label>
            <select
              id="tt-class"
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
            <label className="label" htmlFor="tt-stream">
              Stream
            </label>
            <select
              id="tt-stream"
              className="input"
              value={streamId}
              onChange={(e) => setStreamId(e.target.value)}
              disabled={!classId}
            >
              <option value="">All streams</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {!classId ? (
        <Card>
          <EmptyState title="Choose a class" hint="Select a class to view its weekly timetable." />
        </Card>
      ) : timetable.isLoading ? (
        <Spinner />
      ) : timetable.error ? (
        <ErrorNote error={timetable.error} />
      ) : slots.length === 0 ? (
        <Card>
          <EmptyState title="No timetable published for this class" />
        </Card>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="table min-w-[720px]">
              <thead>
                <tr>
                  <th className="w-32">Period</th>
                  {DAYS.map((d) => (
                    <th key={d.value}>{d.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => {
                  const [start, end] = period.split('-');
                  return (
                    <tr key={period}>
                      <td className="whitespace-nowrap font-mono text-xs text-slate-500">
                        {start}
                        <br />
                        {end}
                      </td>
                      {DAYS.map((d) => {
                        const slot = slots.find(
                          (s) => s.dayOfWeek === d.value && `${s.startTime}-${s.endTime}` === period,
                        );
                        return (
                          <td key={d.value}>
                            {slot ? (
                              <>
                                <span className="block font-medium text-slate-800">
                                  {slot.subject.name}
                                </span>
                                <span className="block text-xs text-slate-500">
                                  {slot.teacher
                                    ? `${slot.teacher.firstName} ${slot.teacher.lastName}`
                                    : 'Unassigned'}
                                  {slot.room ? ` · ${slot.room}` : ''}
                                </span>
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
