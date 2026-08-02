import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, titleCase } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';

interface SchoolSettings {
  id: string;
  name: string;
  code: string;
  motto: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  registrationNo: string | null;
  currency: string;
  rankingEnabled: boolean;
  smsSenderId: string | null;
  plan: string;
  status: string;
  maxStudents: number;
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string | null;
  createdAt: string;
  ipAddress: string | null;
  user: { firstName: string; lastName: string; role: string } | null;
}

export function SettingsPage() {
  const { can, user, isStandalone } = useAuth();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'profile' | 'security' | 'audit'>('profile');
  const [saved, setSaved] = useState(false);
  const [passwordDone, setPasswordDone] = useState(false);

  const school = useQuery({
    queryKey: ['settings', 'school'],
    queryFn: () => get<SchoolSettings>('/settings/school'),
  });

  const audit = useQuery({
    queryKey: ['settings', 'audit'],
    queryFn: () => get<{ data: AuditRow[] }>('/settings/audit-logs?pageSize=100'),
    enabled: tab === 'audit' && can('audit:read'),
  });

  const form = useForm<SchoolSettings>();

  useEffect(() => {
    if (school.data) form.reset(school.data);
  }, [school.data, form]);

  const save = useMutation({
    mutationFn: (values: SchoolSettings) =>
      patch('/settings/school', {
        name: values.name,
        motto: values.motto || null,
        email: values.email || null,
        phone: values.phone || null,
        address: values.address || null,
        city: values.city || null,
        region: values.region || null,
        registrationNo: values.registrationNo || null,
        currency: values.currency,
        rankingEnabled: values.rankingEnabled,
        smsSenderId: values.smsSenderId || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    },
  });

  const passwordForm = useForm<{ currentPassword: string; newPassword: string; confirm: string }>();

  const changePassword = useMutation({
    mutationFn: (values: { currentPassword: string; newPassword: string }) =>
      post('/auth/change-password', values),
    onSuccess: () => {
      passwordForm.reset();
      setPasswordDone(true);
      setTimeout(() => setPasswordDone(false), 5000);
    },
  });

  const canManage = can('school:manage');

  return (
    <>
      <PageHeader title="Settings" subtitle="School profile, security and the audit trail" />

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {(
          [
            ['profile', 'School profile'],
            ['security', 'My account'],
            ['audit', 'Audit trail'],
          ] as const
        )
          .filter(([value]) => value !== 'audit' || can('audit:read'))
          .map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                tab === value
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
      </div>

      {tab === 'profile' &&
        (school.isLoading ? (
          <Spinner />
        ) : school.error ? (
          <ErrorNote error={school.error} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className={isStandalone ? 'lg:col-span-3' : 'lg:col-span-2'}>
              <Card title="School profile">
                {saved && (
                  <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                    Settings saved.
                  </div>
                )}
                {save.error != null && (
                  <div className="mb-4">
                    <ErrorNote error={save.error} />
                  </div>
                )}
                <form
                  onSubmit={form.handleSubmit((v) => save.mutate(v))}
                  className="space-y-4"
                  noValidate
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="School name" required>
                      <input className="input" disabled={!canManage} {...form.register('name', { required: true })} />
                    </Field>
                    <Field label="School code" hint="Used on admission numbers and at sign-in.">
                      <input className="input" disabled {...form.register('code')} />
                    </Field>
                    <Field label="Motto">
                      <input className="input" disabled={!canManage} {...form.register('motto')} />
                    </Field>
                    <Field label="Registration number">
                      <input className="input" disabled={!canManage} {...form.register('registrationNo')} />
                    </Field>
                    <Field label="Email">
                      <input type="email" className="input" disabled={!canManage} {...form.register('email')} />
                    </Field>
                    <Field label="Phone">
                      <input className="input" disabled={!canManage} {...form.register('phone')} />
                    </Field>
                    <Field label="Address">
                      <input className="input" disabled={!canManage} {...form.register('address')} />
                    </Field>
                    <Field label="City">
                      <input className="input" disabled={!canManage} {...form.register('city')} />
                    </Field>
                    <Field label="Region">
                      <input className="input" disabled={!canManage} {...form.register('region')} />
                    </Field>
                    <Field label="Currency" hint="Three-letter code, e.g. TZS.">
                      <input className="input" disabled={!canManage} {...form.register('currency')} />
                    </Field>
                    <Field label="SMS sender ID" hint="Shown as the sender on parent SMS.">
                      <input className="input" maxLength={11} disabled={!canManage} {...form.register('smsSenderId')} />
                    </Field>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" disabled={!canManage} {...form.register('rankingEnabled')} />
                    Show class position on report cards
                  </label>

                  {canManage && (
                    <div className="flex justify-end border-t border-slate-200 pt-4">
                      <button type="submit" className="btn-primary" disabled={save.isPending}>
                        {save.isPending ? 'Saving…' : 'Save settings'}
                      </button>
                    </div>
                  )}
                </form>
              </Card>
            </div>

            {/* Plans and limits mean nothing to a school that owns its copy. */}
            {!isStandalone && (
            <Card title="Subscription">
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
                  <dd className="mt-0.5 font-medium">{titleCase(school.data?.plan ?? '')}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt>
                  <dd className="mt-0.5 font-medium">{titleCase(school.data?.status ?? '')}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Student limit</dt>
                  <dd className="mt-0.5 font-medium">
                    {school.data?.maxStudents.toLocaleString()} students
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-slate-500">
                Contact your provider to change plan or raise these limits.
              </p>
            </Card>
            )}
          </div>
        ))}

      {tab === 'security' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Change my password">
            {passwordDone && (
              <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Password updated.
              </div>
            )}
            {changePassword.error != null && (
              <div className="mb-4">
                <ErrorNote error={changePassword.error} />
              </div>
            )}
            <form
              onSubmit={passwordForm.handleSubmit((v) =>
                changePassword.mutate({
                  currentPassword: v.currentPassword,
                  newPassword: v.newPassword,
                }),
              )}
              className="space-y-4"
              noValidate
            >
              <Field label="Current password" required>
                <input
                  type="password"
                  autoComplete="current-password"
                  className="input"
                  {...passwordForm.register('currentPassword', { required: 'Required' })}
                />
              </Field>
              <Field
                label="New password"
                required
                hint="At least 8 characters with upper case, lower case and a number."
                error={passwordForm.formState.errors.newPassword?.message}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  className="input"
                  {...passwordForm.register('newPassword', {
                    required: 'Required',
                    minLength: { value: 8, message: 'At least 8 characters' },
                    pattern: {
                      value: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
                      message: 'Needs upper case, lower case and a number',
                    },
                  })}
                />
              </Field>
              <Field
                label="Confirm new password"
                required
                error={passwordForm.formState.errors.confirm?.message}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  className="input"
                  {...passwordForm.register('confirm', {
                    required: 'Required',
                    validate: (value) =>
                      value === passwordForm.getValues('newPassword') || 'Passwords do not match',
                  })}
                />
              </Field>
              <div className="flex justify-end border-t border-slate-200 pt-4">
                <button type="submit" className="btn-primary" disabled={changePassword.isPending}>
                  Update password
                </button>
              </div>
            </form>
          </Card>

          <Card title="My account">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Name</dt>
                <dd className="mt-0.5 font-medium">
                  {user?.firstName} {user?.lastName}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Email</dt>
                <dd className="mt-0.5">{user?.email}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Role</dt>
                <dd className="mt-0.5">{titleCase(user?.role ?? '')}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-slate-500">
              Changing your password signs out every other device.
            </p>
          </Card>
        </div>
      )}

      {tab === 'audit' && (
        <Card padded={false}>
          {audit.isLoading ? (
            <Spinner />
          ) : audit.error ? (
            <div className="p-5">
              <ErrorNote error={audit.error} />
            </div>
          ) : audit.data?.data.length === 0 ? (
            <EmptyState title="No audit entries yet" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>IP address</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data?.data.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap text-xs">{dateTime(row.createdAt)}</td>
                      <td>
                        {row.user ? (
                          <>
                            {row.user.firstName} {row.user.lastName}
                            <span className="block text-xs text-slate-400">
                              {titleCase(row.user.role)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="font-mono text-xs">{row.action}</td>
                      <td className="text-slate-500">{row.entityType ?? '—'}</td>
                      <td className="font-mono text-xs text-slate-400">{row.ipAddress ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}
