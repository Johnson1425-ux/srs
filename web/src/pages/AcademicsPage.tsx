import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { AcademicYear, SchoolClass, Subject } from '../lib/types';

interface GradeScale {
  id: string;
  name: string;
  isDefault: boolean;
  bands: Array<{ id: string; grade: string; minScore: number; maxScore: number; points: number; remark: string | null }>;
}

type Dialog = 'class' | 'stream' | 'subject' | 'year' | null;

export function AcademicsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [streamClassId, setStreamClassId] = useState('');

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });
  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => get<{ data: Subject[] }>('/academics/subjects'),
  });
  const years = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => get<{ data: AcademicYear[] }>('/academics/years'),
  });
  const scales = useQuery({
    queryKey: ['grade-scales'],
    queryFn: () => get<{ data: GradeScale[] }>('/academics/grade-scales'),
  });

  const classForm = useForm<{ name: string; level: number }>();
  const streamForm = useForm<{ name: string; capacity: number }>({ defaultValues: { capacity: 40 } });
  const subjectForm = useForm<{ name: string; code: string; passMark: number }>({
    defaultValues: { passMark: 40 },
  });
  const yearForm = useForm<{ name: string; startDate: string; endDate: string; isCurrent: boolean }>();

  const close = () => setDialog(null);
  const refresh = (key: string) => {
    void queryClient.invalidateQueries({ queryKey: [key] });
    close();
  };

  const createClass = useMutation({
    mutationFn: (v: { name: string; level: number }) =>
      post('/academics/classes', { name: v.name, level: Number(v.level) }),
    onSuccess: () => {
      refresh('classes');
      classForm.reset();
    },
  });

  const createStream = useMutation({
    mutationFn: (v: { name: string; capacity: number }) =>
      post(`/academics/classes/${streamClassId}/streams`, {
        name: v.name,
        capacity: Number(v.capacity),
      }),
    onSuccess: () => {
      refresh('classes');
      streamForm.reset({ capacity: 40 });
    },
  });

  const createSubject = useMutation({
    mutationFn: (v: { name: string; code: string; passMark: number }) =>
      post('/academics/subjects', { ...v, passMark: Number(v.passMark) }),
    onSuccess: () => {
      refresh('subjects');
      subjectForm.reset({ passMark: 40 });
    },
  });

  const createYear = useMutation({
    mutationFn: (v: { name: string; startDate: string; endDate: string; isCurrent: boolean }) =>
      post('/academics/years', v),
    onSuccess: () => {
      refresh('academic-years');
      yearForm.reset();
    },
  });

  const setCurrentYear = useMutation({
    mutationFn: (id: string) => post(`/academics/years/${id}/set-current`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['academic-years'] }),
  });

  const manage = can('academics:manage');

  return (
    <>
      <PageHeader title="Academics" subtitle="Classes, streams, subjects, years and grading" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Classes and streams"
          actions={
            manage && (
              <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setDialog('class')}>
                Add class
              </button>
            )
          }
          padded={false}
        >
          {classes.isLoading ? (
            <Spinner />
          ) : classes.data?.data.length === 0 ? (
            <EmptyState title="No classes configured" hint="Add Form 1, Standard 1 and so on." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {classes.data?.data.map((c) => (
                <li key={c.id} className="px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-900">{c.name}</p>
                      <p className="text-xs text-slate-500">
                        Level {c.level} · {c._count.enrollments} students
                      </p>
                    </div>
                    {manage && (
                      <button
                        type="button"
                        className="text-sm text-brand-700 hover:underline"
                        onClick={() => {
                          setStreamClassId(c.id);
                          setDialog('stream');
                        }}
                      >
                        Add stream
                      </button>
                    )}
                  </div>
                  {c.streams.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {c.streams.map((s) => (
                        <li
                          key={s.id}
                          className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                        >
                          {s.name} · {s._count.enrollments}/{s.capacity}
                          {s.classTeacher && (
                            <span className="ml-1 text-slate-500">
                              ({s.classTeacher.firstName} {s.classTeacher.lastName})
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Subjects"
          actions={
            manage && (
              <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setDialog('subject')}>
                Add subject
              </button>
            )
          }
          padded={false}
        >
          {subjects.isLoading ? (
            <Spinner />
          ) : subjects.data?.data.length === 0 ? (
            <EmptyState title="No subjects configured" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Code</th>
                    <th>Department</th>
                    <th className="text-right">Pass mark</th>
                  </tr>
                </thead>
                <tbody>
                  {subjects.data?.data.map((s) => (
                    <tr key={s.id}>
                      <td className="font-medium">{s.name}</td>
                      <td className="font-mono text-xs">{s.code}</td>
                      <td>{s.department?.name ?? '—'}</td>
                      <td className="text-right">{s.passMark}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card
          title="Academic years and terms"
          actions={
            manage && (
              <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setDialog('year')}>
                Add year
              </button>
            )
          }
          padded={false}
        >
          {years.isLoading ? (
            <Spinner />
          ) : years.data?.data.length === 0 ? (
            <EmptyState title="No academic year set" hint="Most modules need a current year." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {years.data?.data.map((y) => (
                <li key={y.id} className="px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-900">
                        {y.name}
                        {y.isCurrent && (
                          <span className="badge ml-2 bg-emerald-100 text-emerald-800">Current</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">
                        {date(y.startDate)} – {date(y.endDate)}
                      </p>
                    </div>
                    {manage && !y.isCurrent && (
                      <button
                        type="button"
                        className="text-sm text-brand-700 hover:underline"
                        onClick={() => setCurrentYear.mutate(y.id)}
                      >
                        Set current
                      </button>
                    )}
                  </div>
                  {y.terms.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {y.terms.map((t) => (
                        <li key={t.id} className="flex items-center gap-1.5 text-xs">
                          <span className="text-slate-700">{t.name}</span>
                          <Badge status={t.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Grading scales" padded={false}>
          {scales.isLoading ? (
            <Spinner />
          ) : scales.data?.data.length === 0 ? (
            <EmptyState title="No grading scale" hint="Marks cannot be graded without one." />
          ) : (
            scales.data?.data.map((scale) => (
              <div key={scale.id} className="border-b border-slate-100 last:border-0">
                <p className="px-5 pt-4 text-sm font-medium text-slate-800">
                  {scale.name}
                  {scale.isDefault && (
                    <span className="badge ml-2 bg-brand-100 text-brand-800">Default</span>
                  )}
                </p>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Grade</th>
                        <th>Range</th>
                        <th className="text-right">Points</th>
                        <th>Remark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scale.bands.map((b) => (
                        <tr key={b.id}>
                          <td className="font-semibold">{b.grade}</td>
                          <td>
                            {b.minScore}–{b.maxScore}%
                          </td>
                          <td className="text-right">{b.points}</td>
                          <td className="text-slate-500">{b.remark ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            ))
          )}
        </Card>
      </div>

      {dialog === 'class' && (
        <Modal title="Add a class" onClose={close}>
          <form onSubmit={classForm.handleSubmit((v) => createClass.mutate(v))} className="space-y-4">
            {createClass.error != null && <ErrorNote error={createClass.error} />}
            <Field label="Class name" required>
              <input className="input" placeholder="Form 1" {...classForm.register('name', { required: true })} />
            </Field>
            <Field label="Level" required hint="Used to order classes and drive promotions.">
              <input
                type="number"
                min={1}
                max={20}
                className="input"
                {...classForm.register('level', { required: true, valueAsNumber: true })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createClass.isPending}>
                Add class
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog === 'stream' && (
        <Modal title="Add a stream" onClose={close}>
          <form onSubmit={streamForm.handleSubmit((v) => createStream.mutate(v))} className="space-y-4">
            {createStream.error != null && <ErrorNote error={createStream.error} />}
            <Field label="Stream name" required>
              <input className="input" placeholder="A" {...streamForm.register('name', { required: true })} />
            </Field>
            <Field label="Capacity" required>
              <input
                type="number"
                min={1}
                className="input"
                {...streamForm.register('capacity', { required: true, valueAsNumber: true })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createStream.isPending}>
                Add stream
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog === 'subject' && (
        <Modal title="Add a subject" onClose={close}>
          <form onSubmit={subjectForm.handleSubmit((v) => createSubject.mutate(v))} className="space-y-4">
            {createSubject.error != null && <ErrorNote error={createSubject.error} />}
            <Field label="Subject name" required>
              <input className="input" placeholder="Mathematics" {...subjectForm.register('name', { required: true })} />
            </Field>
            <Field label="Code" required>
              <input className="input" placeholder="MTH" {...subjectForm.register('code', { required: true })} />
            </Field>
            <Field label="Pass mark (%)" required>
              <input
                type="number"
                min={0}
                max={100}
                className="input"
                {...subjectForm.register('passMark', { required: true, valueAsNumber: true })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createSubject.isPending}>
                Add subject
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog === 'year' && (
        <Modal title="Add an academic year" onClose={close}>
          <form onSubmit={yearForm.handleSubmit((v) => createYear.mutate(v))} className="space-y-4">
            {createYear.error != null && <ErrorNote error={createYear.error} />}
            <Field label="Year name" required>
              <input className="input" placeholder="2027" {...yearForm.register('name', { required: true })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date" required>
                <input type="date" className="input" {...yearForm.register('startDate', { required: true })} />
              </Field>
              <Field label="End date" required>
                <input type="date" className="input" {...yearForm.register('endDate', { required: true })} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" {...yearForm.register('isCurrent')} />
              Make this the current academic year
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createYear.isPending}>
                Add year
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
