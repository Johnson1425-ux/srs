import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { titleCase } from '../lib/format';
import { Card, ErrorNote, Field, PageHeader } from '../components/ui';

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

/**
 * The signed-in user's own account.
 *
 * Deliberately free of any school context: platform staff belong to no school,
 * so anything reached through the school-scoped Settings page is closed to them
 * until they pick a tenant — which is no way to change your own password.
 */
export function AccountPage() {
  const { user } = useAuth();
  const [done, setDone] = useState(false);

  const form = useForm<PasswordForm>();

  const changePassword = useMutation({
    mutationFn: (values: PasswordForm) =>
      post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: () => {
      form.reset();
      setDone(true);
    },
  });

  return (
    <>
      <PageHeader title="My account" subtitle="Your details and your password" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="My details">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium">
                {user?.firstName} {user?.lastName}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium">{user?.email}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Role</dt>
              <dd className="font-medium">{titleCase(user?.role ?? '')}</dd>
            </div>
            <div>
              <dt className="text-slate-500">School</dt>
              <dd className="font-medium">{user?.school?.name ?? 'Platform (no school)'}</dd>
            </div>
          </dl>
          <p className="mt-4 border-t border-slate-200 pt-4 text-xs text-slate-500">
            Your name and role are set by an administrator. Ask them if either is wrong.
          </p>
        </Card>

        <Card title="Change my password">
          {done && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Password updated. Other devices stay signed in — sign them out from the Users page if
              that is what you intended.
            </div>
          )}
          {changePassword.error != null && (
            <div className="mb-4">
              <ErrorNote error={changePassword.error} />
            </div>
          )}

          <form
            onSubmit={form.handleSubmit((v) => changePassword.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <Field label="Current password" required>
              <input
                type="password"
                autoComplete="current-password"
                className="input"
                {...form.register('currentPassword', { required: 'Required' })}
              />
            </Field>
            <Field
              label="New password"
              required
              hint="At least 8 characters with upper case, lower case and a number."
              error={form.formState.errors.newPassword?.message}
            >
              <input
                type="password"
                autoComplete="new-password"
                className="input"
                {...form.register('newPassword', {
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
              error={form.formState.errors.confirm?.message}
            >
              <input
                type="password"
                autoComplete="new-password"
                className="input"
                {...form.register('confirm', {
                  required: 'Required',
                  validate: (value) =>
                    value === form.getValues('newPassword') || 'Passwords do not match',
                })}
              />
            </Field>
            <div className="flex justify-end border-t border-slate-200 pt-4">
              <button type="submit" className="btn-primary" disabled={changePassword.isPending}>
                {changePassword.isPending ? 'Updating…' : 'Update password'}
              </button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
