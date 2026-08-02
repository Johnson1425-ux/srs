import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { download, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fullName, titleCase } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { Paginated, SchoolClass, Student } from '../lib/types';

interface AdmissionForm {
  firstName: string;
  middleName?: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
  dateOfBirth: string;
  nationality?: string;
  address?: string;
  previousSchool?: string;
  medicalConditions?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  classId: string;
  streamId?: string;
  createPortalAccount: boolean;
  guardianFirstName?: string;
  guardianLastName?: string;
  guardianRelationship?: string;
  guardianPhone?: string;
  guardianEmail?: string;
  guardianPortal: boolean;
}

export function StudentsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [credentials, setCredentials] = useState<
    Array<{ role: string; name: string; email: string; password: string }> | null
  >(null);

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });

  const query = qs({ page, pageSize: 25, search, classId, status });
  const students = useQuery({
    queryKey: ['students', query],
    queryFn: () => get<Paginated<Student>>(`/students${query}`),
  });

  const form = useForm<AdmissionForm>({
    defaultValues: { gender: 'MALE', createPortalAccount: false, guardianPortal: false },
  });
  const selectedClassId = form.watch('classId');
  const streams = classes.data?.data.find((c) => c.id === selectedClassId)?.streams ?? [];

  const admit = useMutation({
    mutationFn: (values: AdmissionForm) => {
      const guardians = values.guardianFirstName
        ? [
            {
              firstName: values.guardianFirstName,
              lastName: values.guardianLastName,
              relationship: values.guardianRelationship,
              phone: values.guardianPhone,
              email: values.guardianEmail || null,
              isPrimary: true,
              isFeePayer: true,
              createPortalAccount: values.guardianPortal,
            },
          ]
        : undefined;

      return post<{
        student: Student;
        credentials: Array<{ role: string; name: string; email: string; password: string }>;
      }>('/students', {
        firstName: values.firstName,
        middleName: values.middleName || null,
        lastName: values.lastName,
        gender: values.gender,
        dateOfBirth: values.dateOfBirth,
        nationality: values.nationality || undefined,
        address: values.address || null,
        previousSchool: values.previousSchool || null,
        medicalConditions: values.medicalConditions || null,
        emergencyContactName: values.emergencyContactName || null,
        emergencyContactPhone: values.emergencyContactPhone || null,
        classId: values.classId,
        streamId: values.streamId || null,
        createPortalAccount: values.createPortalAccount,
        guardians,
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['students'] });
      setShowForm(false);
      form.reset();
      if (result.credentials.length > 0) setCredentials(result.credentials);
    },
  });

  return (
    <>
      <PageHeader
        title="Students"
        subtitle="Admissions register and student records"
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                download(`/reports/students${qs({ classId, format: 'csv' })}`, 'students.csv')
              }
            >
              Export CSV
            </button>
            {can('students:manage') && (
              <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
                Admit student
              </button>
            )}
          </>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <input
            className="input sm:max-w-xs"
            placeholder="Search by name or admission number"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search students"
          />
          <select
            className="input sm:max-w-[180px]"
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by class"
          >
            <option value="">All classes</option>
            {classes.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="input sm:max-w-[180px]"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="">Active register</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="GRADUATED">Graduated</option>
            <option value="TRANSFERRED">Transferred</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>

        {students.isLoading ? (
          <Spinner />
        ) : students.error ? (
          <div className="p-5">
            <ErrorNote error={students.error} />
          </div>
        ) : students.data && students.data.data.length === 0 ? (
          <EmptyState title="No students found" hint="Try a different search or filter." />
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Admission No</th>
                    <th>Name</th>
                    <th>Class</th>
                    <th>Gender</th>
                    <th>Guardian</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {students.data?.data.map((student) => {
                    const enrollment = student.enrollments[0];
                    const primary =
                      student.guardianLinks.find((g) => g.isPrimary) ?? student.guardianLinks[0];
                    return (
                      <tr key={student.id}>
                        <td className="font-mono text-xs">{student.admissionNumber}</td>
                        <td className="font-medium text-slate-900">{fullName(student)}</td>
                        <td>
                          {enrollment
                            ? `${enrollment.schoolClass.name}${enrollment.stream ? ` ${enrollment.stream.name}` : ''}`
                            : '—'}
                        </td>
                        <td>{titleCase(student.gender)}</td>
                        <td>
                          {primary ? (
                            <>
                              {primary.guardian.firstName} {primary.guardian.lastName}
                              <span className="block text-xs text-slate-400">
                                {primary.guardian.phone}
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <Badge status={student.status} />
                        </td>
                        <td className="text-right">
                          <Link
                            to={`/students/${student.id}`}
                            className="text-sm text-brand-700 hover:underline"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            {students.data && (
              <Pagination
                page={students.data.meta.page}
                totalPages={students.data.meta.totalPages}
                total={students.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      {showForm && (
        <Modal title="Admit a new student" onClose={() => setShowForm(false)} wide>
          <form
            onSubmit={form.handleSubmit((values) => admit.mutate(values))}
            className="space-y-6"
            noValidate
          >
            {admit.error != null && <ErrorNote error={admit.error} />}

            <div>
              <h3 className="mb-3 text-sm font-semibold text-slate-800">Student details</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" required error={form.formState.errors.firstName?.message}>
                  <input
                    className="input"
                    {...form.register('firstName', { required: 'Required' })}
                  />
                </Field>
                <Field label="Middle name">
                  <input className="input" {...form.register('middleName')} />
                </Field>
                <Field label="Last name" required error={form.formState.errors.lastName?.message}>
                  <input className="input" {...form.register('lastName', { required: 'Required' })} />
                </Field>
                <Field label="Gender" required>
                  <select className="input" {...form.register('gender', { required: true })}>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                  </select>
                </Field>
                <Field
                  label="Date of birth"
                  required
                  error={form.formState.errors.dateOfBirth?.message}
                >
                  <input
                    type="date"
                    className="input"
                    max={new Date().toISOString().slice(0, 10)}
                    {...form.register('dateOfBirth', { required: 'Required' })}
                  />
                </Field>
                <Field label="Nationality">
                  <input className="input" placeholder="Tanzanian" {...form.register('nationality')} />
                </Field>
                <Field label="Class" required error={form.formState.errors.classId?.message}>
                  <select className="input" {...form.register('classId', { required: 'Required' })}>
                    <option value="">Select a class</option>
                    {classes.data?.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Stream">
                  <select className="input" {...form.register('streamId')} disabled={!selectedClassId}>
                    <option value="">No stream</option>
                    {streams.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s._count.enrollments}/{s.capacity})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Home address">
                  <input className="input" {...form.register('address')} />
                </Field>
                <Field label="Previous school">
                  <input className="input" {...form.register('previousSchool')} />
                </Field>
                <Field label="Emergency contact name">
                  <input className="input" {...form.register('emergencyContactName')} />
                </Field>
                <Field label="Emergency contact phone">
                  <input className="input" placeholder="0754 000 000" {...form.register('emergencyContactPhone')} />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Medical conditions" hint="Allergies, chronic conditions, medication.">
                    <textarea className="input" rows={2} {...form.register('medicalConditions')} />
                  </Field>
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" {...form.register('createPortalAccount')} />
                Create a student portal login
              </label>
            </div>

            <div className="border-t border-slate-200 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-800">
                Parent / guardian <span className="font-normal text-slate-400">(optional)</span>
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name">
                  <input className="input" {...form.register('guardianFirstName')} />
                </Field>
                <Field label="Last name">
                  <input className="input" {...form.register('guardianLastName')} />
                </Field>
                <Field label="Relationship">
                  <select className="input" {...form.register('guardianRelationship')}>
                    <option value="">Select…</option>
                    <option value="Father">Father</option>
                    <option value="Mother">Mother</option>
                    <option value="Guardian">Guardian</option>
                  </select>
                </Field>
                <Field label="Phone" hint="Used for fee reminders and absence alerts.">
                  <input className="input" placeholder="0754 000 000" {...form.register('guardianPhone')} />
                </Field>
                <Field label="Email">
                  <input type="email" className="input" {...form.register('guardianEmail')} />
                </Field>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" {...form.register('guardianPortal')} />
                Create a parent portal login
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-5">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={admit.isPending}>
                {admit.isPending ? 'Admitting…' : 'Admit student'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {credentials && (
        <Modal title="Portal logins created" onClose={() => setCredentials(null)}>
          <p className="mb-4 text-sm text-slate-600">
            Hand these over securely. Each account must change its password at first sign-in.
          </p>
          <ul className="space-y-3">
            {credentials.map((c) => (
              <li key={c.email} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-800">
                  {c.name} · {titleCase(c.role)}
                </p>
                <p className="mt-1 font-mono text-xs text-slate-600">{c.email}</p>
                <p className="font-mono text-xs text-slate-600">{c.password}</p>
              </li>
            ))}
          </ul>
          <div className="mt-5 text-right">
            <button type="button" className="btn-primary" onClick={() => setCredentials(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
