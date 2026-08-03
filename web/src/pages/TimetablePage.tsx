import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { del, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
} from '../components/ui';
import type { AcademicYear, Paginated, SchoolClass, StaffMember, Subject } from '../lib/types';

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

interface SlotForm {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  subjectId: string;
  teacherId: string;
  room: string;
}

export function TimetablePage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [classId, setClassId] = useState('');
  const [streamId, setStreamId] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });
  const streams = classes.data?.data.find((c) => c.id === classId)?.streams ?? [];

  const years = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => get<{ data: AcademicYear[] }>('/academics/years'),
  });
  const currentYear = years.data?.data.find((y) => y.isCurrent);

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => get<{ data: Subject[] }>('/academics/subjects'),
    enabled: addOpen,
  });

  const teachers = useQuery({
    queryKey: ['staff', 'teaching'],
    queryFn: () => get<Paginated<StaffMember>>('/staff?staffType=TEACHING&pageSize=100'),
    enabled: addOpen && can('staff:read'),
  });

  const form = useForm<SlotForm>({
    defaultValues: { dayOfWeek: 1, startTime: '08:00', endTime: '08:40', room: '' },
  });

  const addSlot = useMutation({
    mutationFn: (values: SlotForm) =>
      post('/academics/timetable', {
        academicYearId: currentYear?.id,
        classId,
        streamId: streamId || null,
        subjectId: values.subjectId,
        teacherId: values.teacherId || null,
        dayOfWeek: Number(values.dayOfWeek),
        startTime: values.startTime,
        endTime: values.endTime,
        room: values.room || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['timetable'] });
      setAddOpen(false);
      form.reset({ dayOfWeek: 1, startTime: '08:00', endTime: '08:40', room: '' });
    },
  });

  const removeSlot = useMutation({
    mutationFn: (slotId: string) => del(`/academics/timetable/${slotId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timetable'] }),
  });

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
      <PageHeader
        title="Timetable"
        subtitle="Weekly lesson schedule by class and stream"
        actions={
          can('academics:manage') &&
          classId && (
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
              Add lesson
            </button>
          )
        }
      />

      {removeSlot.error != null && (
        <div className="mb-4">
          <ErrorNote error={removeSlot.error} />
        </div>
      )}

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
                              <div className="group flex items-start justify-between gap-2">
                                <div>
                                  <span className="block font-medium text-slate-800">
                                    {slot.subject.name}
                                  </span>
                                  <span className="block text-xs text-slate-500">
                                    {slot.teacher
                                      ? `${slot.teacher.firstName} ${slot.teacher.lastName}`
                                      : 'Unassigned'}
                                    {slot.room ? ` · ${slot.room}` : ''}
                                  </span>
                                </div>
                                {can('academics:manage') && (
                                  <button
                                    type="button"
                                    className="shrink-0 text-xs text-slate-300 hover:text-red-700 disabled:opacity-50"
                                    disabled={removeSlot.isPending}
                                    title="Remove this lesson"
                                    aria-label={`Remove ${slot.subject.name} on ${DAYS.find((x) => x.value === d.value)?.label} at ${slot.startTime}`}
                                    onClick={() => removeSlot.mutate(slot.id)}
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
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

      {addOpen && (
        <Modal title="Add a lesson" onClose={() => setAddOpen(false)}>
          <form
            onSubmit={form.handleSubmit((v) => addSlot.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {addSlot.error != null && <ErrorNote error={addSlot.error} />}

            {!currentYear && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                No current academic year is set. Choose one under Academics first — a lesson has to
                belong to a year.
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Day" required>
                <select
                  className="input"
                  {...form.register('dayOfWeek', { required: true, valueAsNumber: true })}
                >
                  {DAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Room">
                <input className="input" placeholder="Form 1A" {...form.register('room')} />
              </Field>
              <Field label="Starts" required>
                <input
                  type="time"
                  className="input"
                  {...form.register('startTime', { required: true })}
                />
              </Field>
              <Field
                label="Ends"
                required
                error={form.formState.errors.endTime?.message}
              >
                <input
                  type="time"
                  className="input"
                  {...form.register('endTime', {
                    required: true,
                    validate: (value) =>
                      value > form.getValues('startTime') || 'Must be after the start time',
                  })}
                />
              </Field>
            </div>

            <Field label="Subject" required>
              <select className="input" {...form.register('subjectId', { required: true })}>
                <option value="">Select…</option>
                {subjects.data?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Teacher" hint="Leave blank to assign later.">
              <select className="input" {...form.register('teacherId')}>
                <option value="">Unassigned</option>
                {teachers.data?.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.firstName} {t.lastName}
                  </option>
                ))}
              </select>
            </Field>

            <p className="text-xs text-slate-500">
              A teacher already booked for another class at this time will be rejected — the clash
              is reported rather than double-booked.
            </p>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setAddOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={addSlot.isPending || !currentYear}
              >
                {addSlot.isPending ? 'Adding…' : 'Add lesson'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
