import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, patch, post } from '../lib/api';
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
  StatTile,
  TableWrap,
} from '../components/ui';

interface SchoolRow {
  id: string;
  name: string;
  code: string;
  city: string | null;
  status: string;
  plan: string;
  maxStudents: number;
  planEndsAt: string | null;
  createdAt: string;
  _count: { users: number; students: number; staff: number };
}

interface Usage {
  schools: number;
  byStatus: Record<string, number>;
  byPlan: Record<string, number>;
  totalActiveStudents: number;
  totalUsers: number;
  storageUsedMb: number;
}

interface OnboardForm {
  name: string;
  code: string;
  email?: string;
  phone?: string;
  city?: string;
  region?: string;
  plan: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
}

const PLANS = ['TRIAL', 'BASIC', 'STANDARD', 'PREMIUM'] as const;

/** Module 22 — multi-school SaaS administration, super admin only. */
export function PlatformPage() {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; school: string } | null>(
    null,
  );

  const schools = useQuery({
    queryKey: ['platform', 'schools'],
    queryFn: () => get<{ data: SchoolRow[]; meta: { total: number } }>('/platform/schools?pageSize=100'),
    enabled: hasRole('SUPER_ADMIN'),
  });

  const usage = useQuery({
    queryKey: ['platform', 'usage'],
    queryFn: () => get<Usage>('/platform/usage'),
    enabled: hasRole('SUPER_ADMIN'),
  });

  const form = useForm<OnboardForm>({ defaultValues: { plan: 'TRIAL' } });

  const onboard = useMutation({
    mutationFn: (values: OnboardForm) =>
      post<{ school: SchoolRow; administrator: { email: string; temporaryPassword: string } }>(
        '/platform/schools',
        {
          name: values.name,
          code: values.code,
          email: values.email || null,
          phone: values.phone || null,
          city: values.city || null,
          region: values.region || null,
          plan: values.plan,
          admin: {
            firstName: values.adminFirstName,
            lastName: values.adminLastName,
            email: values.adminEmail,
          },
        },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      setShowForm(false);
      form.reset({ plan: 'TRIAL' });
      setCreated({
        school: result.school.name,
        email: result.administrator.email,
        password: result.administrator.temporaryPassword,
      });
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      patch(`/platform/schools/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform'] }),
  });

  if (!hasRole('SUPER_ADMIN')) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Platform administration</h1>
        <p className="mt-2 text-sm text-slate-500">
          This section is reserved for the system provider.
        </p>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Schools"
        subtitle="Multi-school administration, subscriptions and usage"
        actions={
          <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
            Onboard a school
          </button>
        }
      />

      {usage.data && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Schools" value={usage.data.schools} hint={`${usage.data.byStatus.ACTIVE ?? 0} active`} />
          <StatTile
            label="Active students"
            value={usage.data.totalActiveStudents.toLocaleString()}
            tone="emerald"
          />
          <StatTile label="User accounts" value={usage.data.totalUsers.toLocaleString()} tone="slate" />
          <StatTile label="Storage used" value={`${usage.data.storageUsedMb} MB`} tone="amber" />
        </div>
      )}

      {setStatus.error != null && (
        <div className="mb-4">
          <ErrorNote error={setStatus.error} />
        </div>
      )}

      <Card padded={false}>
        {schools.isLoading ? (
          <Spinner />
        ) : schools.error ? (
          <div className="p-5">
            <ErrorNote error={schools.error} />
          </div>
        ) : schools.data?.data.length === 0 ? (
          <EmptyState title="No schools yet" hint="Onboard the first tenant to get started." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>School</th>
                  <th>Code</th>
                  <th>Plan</th>
                  <th className="text-right">Students</th>
                  <th className="text-right">Staff</th>
                  <th>Renews</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schools.data?.data.map((s) => {
                  const atLimit = s._count.students >= s.maxStudents;
                  return (
                    <tr key={s.id}>
                      <td className="font-medium text-slate-900">
                        {s.name}
                        {s.city && <span className="block text-xs text-slate-400">{s.city}</span>}
                      </td>
                      <td className="font-mono text-xs">{s.code}</td>
                      <td>{titleCase(s.plan)}</td>
                      <td className={`text-right ${atLimit ? 'font-semibold text-red-700' : ''}`}>
                        {s._count.students}/{s.maxStudents}
                      </td>
                      <td className="text-right">{s._count.staff}</td>
                      <td>{date(s.planEndsAt)}</td>
                      <td>
                        <Badge status={s.status} />
                      </td>
                      <td className="text-right">
                        {s.status === 'SUSPENDED' ? (
                          <button
                            type="button"
                            className="text-sm text-emerald-700 hover:underline"
                            onClick={() => setStatus.mutate({ id: s.id, status: 'ACTIVE' })}
                          >
                            Reactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="text-sm text-red-700 hover:underline"
                            onClick={() => setStatus.mutate({ id: s.id, status: 'SUSPENDED' })}
                          >
                            Suspend
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {showForm && (
        <Modal title="Onboard a new school" onClose={() => setShowForm(false)} wide>
          <form
            onSubmit={form.handleSubmit((v) => onboard.mutate(v))}
            className="space-y-5"
            noValidate
          >
            {onboard.error != null && <ErrorNote error={onboard.error} />}

            <div>
              <h3 className="mb-3 text-sm font-semibold text-slate-800">School</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="School name" required>
                  <input className="input" {...form.register('name', { required: true })} />
                </Field>
                <Field label="School code" required hint="Short alphanumeric prefix, e.g. MLM.">
                  <input
                    className="input uppercase"
                    maxLength={12}
                    {...form.register('code', { required: true })}
                  />
                </Field>
                <Field label="Subscription plan" required>
                  <select className="input" {...form.register('plan')}>
                    {PLANS.map((p) => (
                      <option key={p} value={p}>
                        {titleCase(p)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="School email">
                  <input type="email" className="input" {...form.register('email')} />
                </Field>
                <Field label="Phone">
                  <input className="input" {...form.register('phone')} />
                </Field>
                <Field label="City">
                  <input className="input" {...form.register('city')} />
                </Field>
                <Field label="Region">
                  <input className="input" {...form.register('region')} />
                </Field>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-800">First administrator</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" required>
                  <input className="input" {...form.register('adminFirstName', { required: true })} />
                </Field>
                <Field label="Last name" required>
                  <input className="input" {...form.register('adminLastName', { required: true })} />
                </Field>
                <Field label="Email" required>
                  <input
                    type="email"
                    className="input"
                    {...form.register('adminEmail', { required: true })}
                  />
                </Field>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                The school starts with a default Tanzanian grading scale, and the administrator
                receives a one-time password they must change at first sign-in.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={onboard.isPending}>
                {onboard.isPending ? 'Creating…' : 'Onboard school'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {created && (
        <Modal title="School created" onClose={() => setCreated(null)}>
          <p className="mb-4 text-sm text-slate-600">
            <strong>{created.school}</strong> is ready. Send the administrator these credentials
            securely.
          </p>
          <div className="rounded-lg border border-slate-200 p-4 font-mono text-sm">
            <p>{created.email}</p>
            <p>{created.password}</p>
          </div>
          <div className="mt-5 text-right">
            <button type="button" className="btn-primary" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
