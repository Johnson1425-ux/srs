import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, titleCase } from '../lib/format';
import {
  ActionMenu,
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

interface SubscriptionForm {
  plan: string;
  planEndsAt: string;
  maxStudents: number;
  storageQuotaMb: number;
}

interface SchoolRow {
  id: string;
  name: string;
  code: string;
  city: string | null;
  status: string;
  plan: string;
  maxStudents: number;
  storageQuotaMb: number;
  planEndsAt: string | null;
  createdAt: string;
  _count: { users: number; students: number; staff: number };
}

interface PlatformUser {
  id: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string;
  status: string;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  _count?: { sessions: number };
}

interface AdminForm {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
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

/** Mirrors the server's plan limits, so choosing a plan shows what it grants. */
const PLAN_LIMITS: Record<string, { maxStudents: number; storageQuotaMb: number }> = {
  TRIAL: { maxStudents: 100, storageQuotaMb: 512 },
  BASIC: { maxStudents: 500, storageQuotaMb: 2048 },
  STANDARD: { maxStudents: 2000, storageQuotaMb: 10240 },
  PREMIUM: { maxStudents: 5000, storageQuotaMb: 51200 },
};

/** Module 22 — multi-school SaaS administration, super admin only. */
export function PlatformPage() {
  const { hasRole, setActiveSchool, user: me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState<{
    email: string;
    password: string;
    /** What the credentials belong to — a school, or platform administration. */
    subject: string;
    kind: 'school' | 'administrator';
  } | null>(null);
  const [editing, setEditing] = useState<SchoolRow | null>(null);
  const [deleting, setDeleting] = useState<SchoolRow | null>(null);
  const [confirmCode, setConfirmCode] = useState('');

  const subscriptionForm = useForm<SubscriptionForm>();
  const [tab, setTab] = useState<'schools' | 'admins'>('schools');
  const [showAdminForm, setShowAdminForm] = useState(false);
  const adminForm = useForm<AdminForm>();

  const admins = useQuery({
    queryKey: ['platform', 'users'],
    queryFn: () => get<{ data: PlatformUser[] }>('/platform/users'),
    enabled: hasRole('SUPER_ADMIN') && tab === 'admins',
  });

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
        kind: 'school',
        subject: result.school.name,
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

  const saveSubscription = useMutation({
    mutationFn: (values: SubscriptionForm & { id: string }) =>
      patch(`/platform/schools/${values.id}`, {
        plan: values.plan,
        planEndsAt: values.planEndsAt || undefined,
        maxStudents: Number(values.maxStudents),
        storageQuotaMb: Number(values.storageQuotaMb),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      setEditing(null);
    },
  });

  const removeSchool = useMutation({
    mutationFn: (school: SchoolRow) =>
      del(`/platform/schools/${school.id}`, { confirmCode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      setDeleting(null);
      setConfirmCode('');
    },
  });

  const addAdmin = useMutation({
    mutationFn: (values: AdminForm) =>
      post<PlatformUser & { temporaryPassword?: string }>('/platform/users', {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone || undefined,
      }),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'users'] });
      setShowAdminForm(false);
      adminForm.reset();
      if (user.temporaryPassword) {
        setCreated({
          kind: 'administrator',
          subject: `${user.firstName} ${user.lastName}`,
          email: user.email,
          password: user.temporaryPassword,
        });
      }
    },
  });

  const setAdminStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      patch(`/platform/users/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform', 'users'] }),
  });

  const resetAdminPassword = useMutation({
    mutationFn: (u: PlatformUser) =>
      post<{ temporaryPassword: string }>(`/platform/users/${u.id}/reset-password`),
    onSuccess: (result, u) => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'users'] });
      setCreated({
        kind: 'administrator',
        subject: `${u.firstName} ${u.lastName}`,
        email: u.email,
        password: result.temporaryPassword,
      });
    },
  });

  const removeAdmin = useMutation({
    mutationFn: (u: PlatformUser) => del(`/platform/users/${u.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform', 'users'] }),
  });

  const openSubscription = (school: SchoolRow) => {
    subscriptionForm.reset({
      plan: school.plan,
      planEndsAt: school.planEndsAt ? school.planEndsAt.slice(0, 10) : '',
      maxStudents: school.maxStudents,
      storageQuotaMb: school.storageQuotaMb,
    });
    setEditing(school);
  };

  /**
   * Enters a school and goes to its records. Platform staff belong to no
   * school, so without this every school-scoped screen — its users, its fees —
   * is unreachable, which is not obvious from a page listing schools.
   */
  const openSchool = (school: SchoolRow) => {
    setActiveSchool(school.id);
    navigate('/users');
  };

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

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(['schools', 'admins'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'schools' ? 'Schools' : 'Administrators'}
          </button>
        ))}
      </div>

      {tab === 'admins' && (
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-slate-800">Platform administrators</p>
              <p className="mt-1 text-xs text-slate-500">
                These accounts belong to no school and can reach every tenant. Keep the list short.
              </p>
            </div>
            <button type="button" className="btn-primary" onClick={() => setShowAdminForm(true)}>
              Add administrator
            </button>
          </div>

          {removeAdmin.error != null && (
            <div className="p-5">
              <ErrorNote error={removeAdmin.error} />
            </div>
          )}
          {setAdminStatus.error != null && (
            <div className="p-5">
              <ErrorNote error={setAdminStatus.error} />
            </div>
          )}

          {admins.isLoading ? (
            <Spinner />
          ) : admins.error ? (
            <div className="p-5">
              <ErrorNote error={admins.error} />
            </div>
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {admins.data?.data.map((u) => {
                    const isMe = u.id === me?.id;
                    return (
                      <tr key={u.id}>
                        <td className="font-medium text-slate-900">
                          {u.firstName} {u.lastName}
                          {isMe && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                        </td>
                        <td className="text-sm">{u.email}</td>
                        <td>
                          <Badge status={u.status} />
                          {u.mustChangePassword && (
                            <span className="block pt-1 text-xs text-slate-400">
                              Must change password
                            </span>
                          )}
                        </td>
                        <td className="text-sm">
                          {u.lastLoginAt ? (
                            date(u.lastLoginAt)
                          ) : (
                            <span className="text-slate-400">Never</span>
                          )}
                        </td>
                        <td className="text-right">
                          <ActionMenu
                            items={[
                              {
                                label: 'Reset password',
                                onClick: () => resetAdminPassword.mutate(u),
                              },
                              u.status === 'ACTIVE'
                                ? {
                                    label: 'Disable',
                                    onClick: () =>
                                      setAdminStatus.mutate({ id: u.id, status: 'DISABLED' }),
                                    danger: true,
                                    disabled: isMe,
                                  }
                                : {
                                    label: 'Activate',
                                    onClick: () =>
                                      setAdminStatus.mutate({ id: u.id, status: 'ACTIVE' }),
                                  },
                              {
                                label: 'Delete',
                                onClick: () => removeAdmin.mutate(u),
                                danger: true,
                                disabled: isMe,
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {tab === 'schools' && (
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
                        <ActionMenu
                          items={[
                            { label: 'Open this school', onClick: () => openSchool(s) },
                            { label: 'Manage subscription', onClick: () => openSubscription(s) },
                            s.status === 'SUSPENDED'
                              ? {
                                  label: 'Reactivate',
                                  onClick: () => setStatus.mutate({ id: s.id, status: 'ACTIVE' }),
                                }
                              : {
                                  label: 'Suspend',
                                  onClick: () =>
                                    setStatus.mutate({ id: s.id, status: 'SUSPENDED' }),
                                  danger: true,
                                },
                            {
                              label: 'Delete school',
                              onClick: () => {
                                setConfirmCode('');
                                setDeleting(s);
                              },
                              danger: true,
                              // Deleting destroys the records, so service must
                              // be stopped as a separate, earlier decision.
                              disabled: s.status === 'ACTIVE' || s.status === 'TRIAL',
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      )}

      {showAdminForm && (
        <Modal title="Add a platform administrator" onClose={() => setShowAdminForm(false)}>
          <form
            onSubmit={adminForm.handleSubmit((v) => addAdmin.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {addAdmin.error != null && <ErrorNote error={addAdmin.error} />}

            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              A platform administrator can reach every school's records, change any subscription
              and delete a school. Only add someone who needs all of that.
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                <input className="input" {...adminForm.register('firstName', { required: true })} />
              </Field>
              <Field label="Last name" required>
                <input className="input" {...adminForm.register('lastName', { required: true })} />
              </Field>
            </div>
            <Field label="Email" required hint="This is what they sign in with.">
              <input
                className="input"
                type="email"
                {...adminForm.register('email', { required: true })}
              />
            </Field>
            <Field label="Phone">
              <input className="input" {...adminForm.register('phone')} />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowAdminForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={addAdmin.isPending}>
                {addAdmin.isPending ? 'Creating…' : 'Create administrator'}
              </button>
            </div>
          </form>
        </Modal>
      )}


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

      {editing && (
        <Modal title={`Subscription — ${editing.name}`} onClose={() => setEditing(null)}>
          <form
            onSubmit={subscriptionForm.handleSubmit((v) =>
              saveSubscription.mutate({ ...v, id: editing.id }),
            )}
            className="space-y-4"
            noValidate
          >
            {saveSubscription.error != null && <ErrorNote error={saveSubscription.error} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plan" required>
                <select
                  className="input"
                  {...subscriptionForm.register('plan', {
                    required: true,
                    onChange: (e) => {
                      const limits = PLAN_LIMITS[e.target.value];
                      if (!limits) return;
                      subscriptionForm.setValue('maxStudents', limits.maxStudents);
                      subscriptionForm.setValue('storageQuotaMb', limits.storageQuotaMb);
                    },
                  })}
                >
                  {PLANS.map((p) => (
                    <option key={p} value={p}>
                      {titleCase(p)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Renews on" hint="When the current subscription period ends.">
                <input type="date" className="input" {...subscriptionForm.register('planEndsAt')} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Student limit"
                required
                hint={`Currently using ${editing._count.students}.`}
              >
                <input
                  type="number"
                  min={1}
                  className="input"
                  {...subscriptionForm.register('maxStudents', { required: true, min: 1 })}
                />
              </Field>
              <Field label="Storage quota (MB)" required>
                <input
                  type="number"
                  min={1}
                  className="input"
                  {...subscriptionForm.register('storageQuotaMb', { required: true, min: 1 })}
                />
              </Field>
            </div>

            <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              Choosing a plan fills in its standard limits. Change either figure afterwards to
              agree something different with this school.
            </p>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saveSubscription.isPending}>
                {saveSubscription.isPending ? 'Saving…' : 'Save subscription'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <div className="space-y-4">
            {removeSchool.error != null && <ErrorNote error={removeSchool.error} />}

            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              This permanently destroys <strong>{deleting._count.students} student records</strong>,{' '}
              {deleting._count.users} user accounts, and every result, invoice, payment and ledger
              entry belonging to this school. It cannot be undone and there is no export afterwards.
            </div>

            <p className="text-sm text-slate-600">
              If the school has only stopped paying, close this and leave it suspended instead —
              their data is kept and they can be reactivated at any time.
            </p>

            <Field
              label={`Type ${deleting.code} to confirm`}
              required
              hint="This is deliberately awkward."
            >
              <input
                className="input font-mono"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                autoComplete="off"
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={
                  removeSchool.isPending ||
                  confirmCode.trim().toUpperCase() !== deleting.code.toUpperCase()
                }
                onClick={() => removeSchool.mutate(deleting)}
              >
                {removeSchool.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {created && (
        <Modal
          title={created.kind === 'school' ? 'School created' : 'Hand this password over'}
          onClose={() => setCreated(null)}
        >
          <p className="mb-4 text-sm text-slate-600">
            {created.kind === 'school' ? (
              <>
                <strong>{created.subject}</strong> is ready. Send the administrator these
                credentials securely.
              </>
            ) : (
              <>
                A one-time password for <strong>{created.subject}</strong>. It is shown once and
                cannot be retrieved, and they must change it at first sign-in.
              </>
            )}
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
