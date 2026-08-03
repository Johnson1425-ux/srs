import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { del, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, titleCase } from '../lib/format';
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
import type { Paginated, StaffMember } from '../lib/types';

const PORTAL_ROLES = [
  'TEACHER',
  'ACCOUNTANT',
  'LIBRARIAN',
  'RECEPTIONIST',
  'DRIVER',
  'TRANSPORT_OFFICER',
  'ADMIN',
] as const;

interface StaffForm {
  firstName: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
  phone?: string;
  email?: string;
  staffType: 'TEACHING' | 'NON_TEACHING';
  jobTitle?: string;
  departmentId?: string;
  qualification?: string;
  basicSalary?: number;
  bankName?: string;
  bankAccount?: string;
  createPortalAccount: boolean;
  portalRole: string;
}

export function StaffPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [staffType, setStaffType] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);

  const [statusFor, setStatusFor] = useState<StaffMember | null>(null);
  const [newStatus, setNewStatus] = useState<string>('ON_LEAVE');
  const [statusReason, setStatusReason] = useState('');

  const [allowancesFor, setAllowancesFor] = useState<StaffMember | null>(null);
  const [allowanceName, setAllowanceName] = useState('');
  const [allowanceAmount, setAllowanceAmount] = useState<number>(0);

  const query = qs({ page, pageSize: 25, search, staffType });
  const staff = useQuery({
    queryKey: ['staff', query],
    queryFn: () => get<Paginated<StaffMember>>(`/staff${query}`),
  });

  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => get<{ data: Array<{ id: string; name: string }> }>('/academics/departments'),
  });

  const changeStatus = useMutation({
    mutationFn: () =>
      post(`/staff/${statusFor?.id}/status`, {
        employmentStatus: newStatus,
        reason: statusReason || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      setStatusFor(null);
      setStatusReason('');
    },
  });

  const allowances = useQuery({
    queryKey: ['staff', allowancesFor?.id, 'allowances'],
    queryFn: () =>
      get<{
        data: Array<{ id: string; name: string; amount: string; isActive: boolean }>;
        basicSalary: string | null;
        monthlyAllowanceTotal: string;
      }>(`/staff/${allowancesFor?.id}/allowances`),
    enabled: Boolean(allowancesFor),
  });

  const addAllowance = useMutation({
    mutationFn: () =>
      post(`/staff/${allowancesFor?.id}/allowances`, {
        name: allowanceName,
        amount: Number(allowanceAmount),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff', allowancesFor?.id, 'allowances'] });
      setAllowanceName('');
      setAllowanceAmount(0);
    },
  });

  const removeAllowance = useMutation({
    mutationFn: (allowanceId: string) =>
      del(`/staff/${allowancesFor?.id}/allowances/${allowanceId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['staff', allowancesFor?.id, 'allowances'] }),
  });

  const form = useForm<StaffForm>({
    defaultValues: {
      gender: 'MALE',
      staffType: 'TEACHING',
      createPortalAccount: true,
      portalRole: 'TEACHER',
    },
  });

  const create = useMutation({
    mutationFn: (values: StaffForm) =>
      post<StaffMember & { temporaryPassword?: string }>('/staff', {
        ...values,
        phone: values.phone || null,
        email: values.email || null,
        jobTitle: values.jobTitle || null,
        departmentId: values.departmentId || null,
        qualification: values.qualification || null,
        basicSalary: values.basicSalary ? Number(values.basicSalary) : null,
        bankName: values.bankName || null,
        bankAccount: values.bankAccount || null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      setShowForm(false);
      form.reset();
      if (result.temporaryPassword && result.email) {
        setCredential({ email: result.email, password: result.temporaryPassword });
      }
    },
  });

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Teaching and non-teaching employment records"
        actions={
          can('staff:manage') && (
            <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
              Add staff member
            </button>
          )
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <input
            className="input sm:max-w-xs"
            placeholder="Search by name or staff number"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search staff"
          />
          <select
            className="input sm:max-w-[200px]"
            value={staffType}
            onChange={(e) => {
              setStaffType(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by staff type"
          >
            <option value="">All staff</option>
            <option value="TEACHING">Teaching</option>
            <option value="NON_TEACHING">Non-teaching</option>
          </select>
        </div>

        {staff.isLoading ? (
          <Spinner />
        ) : staff.error ? (
          <div className="p-5">
            <ErrorNote error={staff.error} />
          </div>
        ) : staff.data?.data.length === 0 ? (
          <EmptyState title="No staff records found" />
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Staff No</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th>Contact</th>
                    {can('payroll:read') && <th className="text-right">Basic salary</th>}
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {staff.data?.data.map((s) => (
                    <tr key={s.id}>
                      <td className="font-mono text-xs">{s.staffNumber}</td>
                      <td className="font-medium text-slate-900">
                        {s.firstName} {s.lastName}
                      </td>
                      <td>
                        {s.jobTitle ?? titleCase(s.staffType)}
                        {s.user && (
                          <span className="block text-xs text-slate-400">
                            {titleCase(s.user.role)}
                          </span>
                        )}
                      </td>
                      <td>{s.department?.name ?? '—'}</td>
                      <td className="text-xs">
                        {s.phone ?? '—'}
                        {s.email && <span className="block text-slate-400">{s.email}</span>}
                      </td>
                      {can('payroll:read') && (
                        <td className="text-right">
                          {s.basicSalary ? money(s.basicSalary, currency) : '—'}
                        </td>
                      )}
                      <td>
                        <Badge status={s.employmentStatus} />
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {can('payroll:manage') && (
                          <button
                            type="button"
                            className="mr-3 text-sm text-brand-700 hover:underline"
                            onClick={() => setAllowancesFor(s)}
                          >
                            Allowances
                          </button>
                        )}
                        {can('staff:manage') && (
                          <button
                            type="button"
                            className="text-sm text-brand-700 hover:underline"
                            onClick={() => {
                              setStatusFor(s);
                              setNewStatus(
                                s.employmentStatus === 'ACTIVE' ? 'ON_LEAVE' : 'ACTIVE',
                              );
                            }}
                          >
                            Change status
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {staff.data && (
              <Pagination
                page={staff.data.meta.page}
                totalPages={staff.data.meta.totalPages}
                total={staff.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      {statusFor && (
        <Modal
          title={`Change status — ${statusFor.firstName} ${statusFor.lastName}`}
          onClose={() => setStatusFor(null)}
        >
          {changeStatus.error != null && (
            <div className="mb-4">
              <ErrorNote error={changeStatus.error} />
            </div>
          )}
          <div className="space-y-4">
            <Field label="New status" required>
              <select
                className="input"
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
              >
                <option value="ACTIVE">Active</option>
                <option value="ON_LEAVE">On leave</option>
                <option value="SUSPENDED">Suspended</option>
                <option value="TERMINATED">Terminated</option>
              </select>
            </Field>
            <Field label="Reason" hint="Recorded on the audit trail.">
              <textarea
                className="input"
                rows={3}
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
              />
            </Field>

            {(newStatus === 'SUSPENDED' || newStatus === 'TERMINATED') && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                This also disables their system login and signs them out everywhere. They will be
                left out of payroll runs from now on.
              </p>
            )}
            {newStatus === 'ON_LEAVE' && (
              <p className="text-xs text-slate-500">
                Staff on leave keep their login and are still paid.
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setStatusFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={changeStatus.isPending}
                onClick={() => changeStatus.mutate()}
              >
                {changeStatus.isPending ? 'Saving…' : 'Update status'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {allowancesFor && (
        <Modal
          title={`Allowances — ${allowancesFor.firstName} ${allowancesFor.lastName}`}
          onClose={() => setAllowancesFor(null)}
        >
          {(addAllowance.error ?? removeAllowance.error) != null && (
            <div className="mb-4">
              <ErrorNote error={addAllowance.error ?? removeAllowance.error} />
            </div>
          )}

          {allowances.isLoading ? (
            <Spinner />
          ) : (
            <>
              <dl className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Basic salary</dt>
                  <dd className="mt-0.5 font-medium">
                    {allowances.data?.basicSalary
                      ? money(allowances.data.basicSalary, currency)
                      : 'Not set'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">
                    Monthly allowances
                  </dt>
                  <dd className="mt-0.5 font-medium">
                    {money(allowances.data?.monthlyAllowanceTotal, currency)}
                  </dd>
                </div>
              </dl>

              {allowances.data?.data.length === 0 ? (
                <EmptyState
                  title="No allowances set"
                  hint="This person is paid their basic salary only."
                />
              ) : (
                <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {allowances.data?.data.map((a) => (
                    <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
                      <span className="text-slate-800">{a.name}</span>
                      <span className="flex items-center gap-3">
                        <span className="font-medium">{money(a.amount, currency)}</span>
                        <button
                          type="button"
                          className="text-xs text-slate-400 hover:text-red-700"
                          aria-label={`Remove ${a.name}`}
                          disabled={removeAllowance.isPending}
                          onClick={() => removeAllowance.mutate(a.id)}
                        >
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[1.5fr_1fr_auto]">
                <div>
                  <label className="label" htmlFor="allowance-name">
                    Allowance
                  </label>
                  <input
                    id="allowance-name"
                    className="input"
                    list="allowance-suggestions"
                    placeholder="Housing"
                    value={allowanceName}
                    onChange={(e) => setAllowanceName(e.target.value)}
                  />
                  <datalist id="allowance-suggestions">
                    <option value="Housing" />
                    <option value="Transport" />
                    <option value="Responsibility" />
                    <option value="Medical" />
                    <option value="Hardship" />
                  </datalist>
                </div>
                <div>
                  <label className="label" htmlFor="allowance-amount">
                    Monthly amount
                  </label>
                  <input
                    id="allowance-amount"
                    type="number"
                    min={0}
                    step={1000}
                    className="input"
                    value={allowanceAmount}
                    onChange={(e) => setAllowanceAmount(Number(e.target.value))}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    className="btn-primary w-full"
                    disabled={allowanceName.trim().length < 2 || addAllowance.isPending}
                    onClick={() => addAllowance.mutate()}
                  >
                    Save
                  </button>
                </div>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                These are added to basic salary on every payroll run and itemised on the payslip.
                Re-saving an existing name updates its rate.
              </p>
            </>
          )}
        </Modal>
      )}

      {showForm && (
        <Modal title="Add a staff member" onClose={() => setShowForm(false)} wide>
          <form
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
            className="space-y-5"
            noValidate
          >
            {create.error != null && <ErrorNote error={create.error} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                <input className="input" {...form.register('firstName', { required: true })} />
              </Field>
              <Field label="Last name" required>
                <input className="input" {...form.register('lastName', { required: true })} />
              </Field>
              <Field label="Gender" required>
                <select className="input" {...form.register('gender', { required: true })}>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                </select>
              </Field>
              <Field label="Staff type" required>
                <select className="input" {...form.register('staffType', { required: true })}>
                  <option value="TEACHING">Teaching</option>
                  <option value="NON_TEACHING">Non-teaching</option>
                </select>
              </Field>
              <Field label="Job title">
                <input className="input" placeholder="Teacher, Bursar…" {...form.register('jobTitle')} />
              </Field>
              <Field label="Department">
                <select className="input" {...form.register('departmentId')}>
                  <option value="">None</option>
                  {departments.data?.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Phone">
                <input className="input" placeholder="0754 000 000" {...form.register('phone')} />
              </Field>
              <Field label="Email" hint="Required to create a portal login.">
                <input type="email" className="input" {...form.register('email')} />
              </Field>
              <Field label="Qualification">
                <input className="input" placeholder="B.Ed, Diploma…" {...form.register('qualification')} />
              </Field>
              <Field label="Basic salary (monthly)">
                <input
                  type="number"
                  min={0}
                  step={1000}
                  className="input"
                  {...form.register('basicSalary', { valueAsNumber: true })}
                />
              </Field>
              <Field label="Bank">
                <input className="input" {...form.register('bankName')} />
              </Field>
              <Field label="Account number">
                <input className="input" {...form.register('bankAccount')} />
              </Field>
            </div>

            <div className="rounded-lg bg-slate-50 p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" {...form.register('createPortalAccount')} />
                Create a system login
              </label>
              {form.watch('createPortalAccount') && (
                <div className="mt-3">
                  <Field label="System role" hint="Determines what this person can access.">
                    <select className="input" {...form.register('portalRole')}>
                      {PORTAL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {titleCase(r)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Add staff member'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {credential && (
        <Modal title="Login created" onClose={() => setCredential(null)}>
          <p className="mb-4 text-sm text-slate-600">
            Share these credentials securely. The account must change its password at first sign-in.
          </p>
          <div className="rounded-lg border border-slate-200 p-4 font-mono text-sm">
            <p>{credential.email}</p>
            <p>{credential.password}</p>
          </div>
          <div className="mt-5 text-right">
            <button type="button" className="btn-primary" onClick={() => setCredential(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
