import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, titleCase } from '../lib/format';
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
import type { AcademicYear, Exam, SchoolClass, Subject } from '../lib/types';

const EXAM_TYPES = ['MIDTERM', 'TERMINAL', 'ANNUAL', 'MOCK', 'CONTINUOUS_ASSESSMENT'] as const;

interface ExamForm {
  academicYearId: string;
  termId: string;
  classId: string;
  name: string;
  examType: string;
  startDate: string;
  endDate: string;
  maxScore: number;
  subjectIds: string[];
}

export function ExamsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const exams = useQuery({ queryKey: ['exams'], queryFn: () => get<{ data: Exam[] }>('/exams') });
  const years = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => get<{ data: AcademicYear[] }>('/academics/years'),
  });
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });
  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => get<{ data: Subject[] }>('/academics/subjects'),
  });

  const form = useForm<ExamForm>({ defaultValues: { examType: 'TERMINAL', maxScore: 100 } });
  const selectedYear = years.data?.data.find((y) => y.id === form.watch('academicYearId'));

  const create = useMutation({
    mutationFn: (values: ExamForm) =>
      post<Exam>('/exams', {
        academicYearId: values.academicYearId,
        termId: values.termId || null,
        classId: values.classId || null,
        name: values.name,
        examType: values.examType,
        startDate: values.startDate || null,
        endDate: values.endDate || null,
        subjects: values.subjectIds.map((subjectId) => ({
          subjectId,
          maxScore: Number(values.maxScore),
        })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['exams'] });
      setShowForm(false);
      form.reset({ examType: 'TERMINAL', maxScore: 100 });
    },
  });

  const publish = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'publish' | 'unpublish' }) =>
      post(`/exams/${id}/${action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exams'] }),
  });

  return (
    <>
      <PageHeader
        title="Examinations"
        subtitle="Schedule exams, enter marks and publish results"
        actions={
          can('exams:manage') && (
            <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
              New examination
            </button>
          )
        }
      />

      {publish.error != null && (
        <div className="mb-4">
          <ErrorNote error={publish.error} />
        </div>
      )}

      {exams.isLoading ? (
        <Spinner />
      ) : exams.error ? (
        <ErrorNote error={exams.error} />
      ) : exams.data?.data.length === 0 ? (
        <Card>
          <EmptyState title="No examinations yet" hint="Create one to start recording marks." />
        </Card>
      ) : (
        <div className="space-y-4">
          {exams.data?.data.map((exam) => (
            <Card key={exam.id} padded={false}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-slate-900">{exam.name}</h2>
                    <Badge status={exam.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    {titleCase(exam.examType)}
                    {exam.schoolClass ? ` · ${exam.schoolClass.name}` : ''}
                    {exam.term ? ` · ${exam.term.name}` : ''} · {exam.academicYear.name}
                    {exam.startDate ? ` · from ${date(exam.startDate)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to={`/exams/${exam.id}/results`} className="btn-secondary">
                    Result sheet
                  </Link>
                  {can('exams:publish') && (
                    <button
                      type="button"
                      className={exam.status === 'PUBLISHED' ? 'btn-secondary' : 'btn-primary'}
                      disabled={publish.isPending}
                      onClick={() =>
                        publish.mutate({
                          id: exam.id,
                          action: exam.status === 'PUBLISHED' ? 'unpublish' : 'publish',
                        })
                      }
                    >
                      {exam.status === 'PUBLISHED' ? 'Unpublish' : 'Publish results'}
                    </button>
                  )}
                </div>
              </div>

              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Subject</th>
                      <th>Code</th>
                      <th className="text-right">Marked out of</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {exam.examSubjects.map((es) => (
                      <tr key={es.id}>
                        <td>{es.subject.name}</td>
                        <td className="font-mono text-xs">{es.subject.code}</td>
                        <td className="text-right">{es.maxScore}</td>
                        <td className="text-right">
                          {can('exams:enter_marks') && exam.status !== 'PUBLISHED' ? (
                            <Link
                              to={`/exams/subjects/${es.id}/marks`}
                              className="text-sm text-brand-700 hover:underline"
                            >
                              Enter marks
                            </Link>
                          ) : (
                            <Link
                              to={`/exams/subjects/${es.id}/marks`}
                              className="text-sm text-slate-500 hover:underline"
                            >
                              View marks
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Schedule an examination" onClose={() => setShowForm(false)} wide>
          <form
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
            className="space-y-5"
            noValidate
          >
            {create.error != null && <ErrorNote error={create.error} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Examination name" required>
                <input
                  className="input"
                  placeholder="Term 2 Terminal Examination"
                  {...form.register('name', { required: true })}
                />
              </Field>
              <Field label="Type" required>
                <select className="input" {...form.register('examType', { required: true })}>
                  {EXAM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {titleCase(t)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Academic year" required>
                <select className="input" {...form.register('academicYearId', { required: true })}>
                  <option value="">Select…</option>
                  {years.data?.data.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Term">
                <select className="input" {...form.register('termId')}>
                  <option value="">No specific term</option>
                  {selectedYear?.terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Class" required>
                <select className="input" {...form.register('classId', { required: true })}>
                  <option value="">Select…</option>
                  {classes.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Marked out of" required>
                <input
                  type="number"
                  min={1}
                  className="input"
                  {...form.register('maxScore', { required: true, valueAsNumber: true })}
                />
              </Field>
              <Field label="Start date">
                <input type="date" className="input" {...form.register('startDate')} />
              </Field>
              <Field label="End date">
                <input type="date" className="input" {...form.register('endDate')} />
              </Field>
            </div>

            <Field label="Subjects examined" required>
              <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {subjects.data?.data.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      value={s.id}
                      {...form.register('subjectIds', { required: true })}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create examination'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
