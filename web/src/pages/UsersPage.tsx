import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { del, get, patch, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, titleCase } from '../lib/format';
import {
  ActionMenu,
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
import type { Paginated } from '../lib/types';

/** Roles an administrator may assign. Super admin belongs to the platform. */
const ASSIGNABLE_ROLES = [
  'ADMIN',
  'SCHOOL_OWNER',
  'ACCOUNTANT',
  'TEACHER',
  'LIBRARIAN',
  'RECEPTIONIST',
  'TRANSPORT_OFFICER',
  'DRIVER',
  'PARENT',
  'STUDENT',
] as const;

const STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'DISABLED'] as const;

interface User {
  id: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string;
  role: string;
  status: (typeof STATUSES)[number];
  lastLoginAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  _count?: { sessions: number };
}

interface UserForm {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
  password?: string;
}

function statusTone(status: string): string {
  if (status === 'ACTIVE') return 'bg-emerald-100 text-emerald-800';
  if (status === 'INVITED') return 'bg-sky-100 text-sky-800';
  if (status === 'SUSPENDED') return 'bg-amber-100 text-amber-800';
  return 'bg-slate-200 text-slate-700';
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const { can, user: me } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  /** The one-time password to hand over, shown once and never retrievable. */
  const [handover, setHandover] = useState<{ user: User | string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = qs({ page, pageSize: 25, search, role, status });
  const users = useQuery({
    queryKey: ['users', query],
    queryFn: () => get<Paginated<User>>(`/users${query}`),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const form = useForm<UserForm>({ defaultValues: { role: 'TEACHER' } });
  const editForm = useForm<UserForm>();

  const create = useMutation({
    mutationFn: (values: UserForm) =>
      post<User & { temporaryPassword?: string }>('/users', {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone || undefined,
        role: values.role,
        password: values.password || undefined,
      }),
    onSuccess: (created) => {
      refresh();
      setShowForm(false);
      form.reset({ role: 'TEACHER' });
      // A school has hundreds of accounts and the list is alphabetical, so a
      // new one usually lands on a page nobody is looking at. Filter to it, so
      // the administrator can see what they just created and act on it.
      setSearch(created.lastName);
      setPage(1);
      if (created.temporaryPassword) {
        setHandover({ user: `${created.firstName} ${created.lastName}`, password: created.temporaryPassword });
      } else {
        setNotice(`${created.firstName} ${created.lastName} can now sign in.`);
      }
    },
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      patch<User>(`/users/${id}`, body),
    onSuccess: () => {
      refresh();
      setEditing(null);
      setNotice('Account updated.');
    },
  });

  const resetPassword = useMutation({
    mutationFn: (u: User) => post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`),
    onSuccess: (result, u) => {
      refresh();
      setHandover({ user: `${u.firstName} ${u.lastName}`, password: result.temporaryPassword });
    },
  });

  const revokeSessions = useMutation({
    mutationFn: (u: User) => post<{ revoked: number }>(`/users/${u.id}/revoke-sessions`),
    onSuccess: (result, u) => {
      refresh();
      setNotice(
        result.revoked === 0
          ? `${u.firstName} was not signed in anywhere.`
          : `${u.firstName} signed out of ${result.revoked} device(s).`,
      );
    },
  });

  const unlock = useMutation({
    mutationFn: (u: User) => post(`/users/${u.id}/unlock`),
    onSuccess: (_r, u) => {
      refresh();
      setNotice(`${u.firstName}'s account is unlocked.`);
    },
  });

  const remove = useMutation({
    mutationFn: (u: User) => del(`/users/${u.id}`),
    onSuccess: (_r, u) => {
      refresh();
      setDeleting(null);
      setNotice(`${u.firstName} ${u.lastName}'s account was deleted.`);
    },
  });

  const openEdit = (u: User) => {
    editForm.reset({
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone ?? '',
      role: u.role,
    });
    setEditing(u);
  };

  const manage = can('users:manage');

  const actionsFor = (u: User) => {
    const isMe = u.id === me?.id;
    const locked = u.lockedUntil != null && new Date(u.lockedUntil) > new Date();

    return [
      { label: 'Edit details', onClick: () => openEdit(u) },
      ...(locked ? [{ label: 'Unlock account', onClick: () => unlock.mutate(u) }] : []),
      ...(u.status !== 'ACTIVE'
        ? [{ label: 'Activate', onClick: () => update.mutate({ id: u.id, status: 'ACTIVE' }), disabled: isMe }]
        : [
            {
              label: 'Suspend',
              onClick: () => update.mutate({ id: u.id, status: 'SUSPENDED' }),
              disabled: isMe,
            },
          ]),
      ...(u.status !== 'DISABLED'
        ? [
            {
              label: 'Disable',
              onClick: () => update.mutate({ id: u.id, status: 'DISABLED' }),
              danger: true,
              disabled: isMe,
            },
          ]
        : []),
      { label: 'Reset password', onClick: () => resetPassword.mutate(u) },
      {
        label: 'Sign out everywhere',
        onClick: () => revokeSessions.mutate(u),
        disabled: (u._count?.sessions ?? 0) === 0,
      },
      { label: 'Delete', onClick: () => setDeleting(u), danger: true, disabled: isMe },
    ];
  };

  const anyError =
    users.error ??
    update.error ??
    resetPassword.error ??
    revokeSessions.error ??
    unlock.error ??
    remove.error;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who can sign in, what they may do, and how to stop them"
        actions={
          manage && (
            <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
              Add user
            </button>
          )
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <div className="flex items-start justify-between gap-4">
            <span>{notice}</span>
            <button type="button" className="text-emerald-700" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {anyError != null && (
        <div className="mb-4">
          <ErrorNote error={anyError} />
        </div>
      )}

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Search">
            <input
              className="input"
              value={search}
              placeholder="Name or email"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Role">
            <select
              className="input"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All roles</option>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              className="input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        {users.isLoading ? (
          <Spinner label="Loading users…" />
        ) : users.data?.data.length === 0 ? (
          <EmptyState
            title="No users match"
            hint="Try a different search, or clear the role and status filters."
          />
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    {manage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {users.data?.data.map((u) => {
                    const locked = u.lockedUntil != null && new Date(u.lockedUntil) > new Date();
                    return (
                      <tr key={u.id}>
                        <td>
                          {u.firstName} {u.lastName}
                          {u.id === me?.id && (
                            <span className="ml-2 text-xs text-slate-400">(you)</span>
                          )}
                          {u.phone && (
                            <span className="block text-xs text-slate-400">{u.phone}</span>
                          )}
                        </td>
                        <td className="text-sm">{u.email}</td>
                        <td>{titleCase(u.role)}</td>
                        <td>
                          <span className={`badge ${statusTone(u.status)}`}>
                            {titleCase(u.status)}
                          </span>
                          {locked && (
                            <span className="badge ml-1 bg-red-100 text-red-800">Locked</span>
                          )}
                          {u.mustChangePassword && (
                            <span className="block pt-1 text-xs text-slate-400">
                              Must change password
                            </span>
                          )}
                        </td>
                        <td className="text-sm">
                          {u.lastLoginAt ? (
                            dateTime(u.lastLoginAt)
                          ) : (
                            <span className="text-slate-400">Never</span>
                          )}
                          {(u._count?.sessions ?? 0) > 0 && (
                            <span className="block text-xs text-emerald-700">
                              Signed in on {u._count?.sessions} device(s)
                            </span>
                          )}
                        </td>
                        {manage && (
                          <td className="text-right">
                            <ActionMenu items={actionsFor(u)} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            {users.data && (
              <Pagination
                page={users.data.meta.page}
                totalPages={users.data.meta.totalPages}
                total={users.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      {showForm && (
        <Modal title="Add a user" onClose={() => setShowForm(false)}>
          <form
            onSubmit={form.handleSubmit((v) => create.mutate(v))}
            className="space-y-4"
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
            </div>

            <Field label="Email" required hint="This is what they sign in with.">
              <input className="input" type="email" {...form.register('email', { required: true })} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                <input className="input" {...form.register('phone')} />
              </Field>
              <Field label="Role" required>
                <select className="input" {...form.register('role', { required: true })}>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {titleCase(r)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="Password"
              hint="Leave blank and one is generated for you to hand over. Either way they must change it at first sign-in."
            >
              <input className="input" type="text" {...form.register('password')} />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.firstName} ${editing.lastName}`} onClose={() => setEditing(null)}>
          <form
            onSubmit={editForm.handleSubmit((v) =>
              update.mutate({
                id: editing.id,
                firstName: v.firstName,
                lastName: v.lastName,
                phone: v.phone || null,
                ...(editing.id === me?.id ? {} : { role: v.role }),
              }),
            )}
            className="space-y-4"
            noValidate
          >
            {update.error != null && <ErrorNote error={update.error} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                <input className="input" {...editForm.register('firstName', { required: true })} />
              </Field>
              <Field label="Last name" required>
                <input className="input" {...editForm.register('lastName', { required: true })} />
              </Field>
            </div>

            <Field label="Email" hint="Sign-in addresses cannot be changed here.">
              <input className="input" value={editing.email} disabled readOnly />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                <input className="input" {...editForm.register('phone')} />
              </Field>
              <Field
                label="Role"
                hint={editing.id === me?.id ? 'You cannot change your own role.' : undefined}
              >
                <select
                  className="input"
                  disabled={editing.id === me?.id}
                  {...editForm.register('role')}
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {titleCase(r)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {handover && (
        <Modal title="Hand this password over" onClose={() => setHandover(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              A one-time password for <strong>{String(handover.user)}</strong>. It is shown once
              and cannot be retrieved — write it down before closing this. They will be asked to
              change it when they first sign in.
            </p>
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-center font-mono text-lg">
              {handover.password}
            </p>
            <div className="flex justify-end border-t border-slate-200 pt-4">
              <button type="button" className="btn-primary" onClick={() => setHandover(null)}>
                I have written it down
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.firstName} ${deleting.lastName}?`}
          onClose={() => setDeleting(null)}
        >
          <div className="space-y-4">
            {remove.error != null && <ErrorNote error={remove.error} />}
            <p className="text-sm text-slate-600">
              This removes the account entirely and cannot be undone. It only works for an account
              that has never been used — one created by mistake.
            </p>
            <p className="text-sm text-slate-600">
              To stop someone who has been using the system, close this and choose{' '}
              <strong>Disable</strong> instead. That ends their access immediately and keeps their
              name on the payments and results they recorded.
            </p>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
