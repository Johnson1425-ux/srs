import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import {
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
import type { Guardian, Paginated } from '../lib/types';

interface GuardianRow extends Guardian {
  user: { id: string; email: string; status: string } | null;
  studentLinks: Array<{
    id: string;
    isPrimary: boolean;
    isFeePayer: boolean;
    student: { id: string; firstName: string; lastName: string; admissionNumber: string };
  }>;
}

interface Statement {
  guardian: { firstName: string; lastName: string };
  summary: { totalBilled: number; totalPaid: number; balance: number };
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    dueDate: string;
    total: string;
    balance: string;
    student: { firstName: string; lastName: string; admissionNumber: string };
  }>;
}

interface GuardianForm {
  firstName: string;
  lastName: string;
  relationship: string;
  phone: string;
  altPhone?: string;
  email?: string;
  occupation?: string;
  address?: string;
  createPortalAccount: boolean;
}

export function ParentsPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);

  const query = qs({ page, pageSize: 25, search });
  const parents = useQuery({
    queryKey: ['parents', query],
    queryFn: () => get<Paginated<GuardianRow>>(`/parents${query}`),
  });

  const statement = useQuery({
    queryKey: ['parents', statementFor, 'statement'],
    queryFn: () => get<Statement>(`/parents/${statementFor}/fee-statement`),
    enabled: Boolean(statementFor),
  });

  const form = useForm<GuardianForm>({
    defaultValues: { relationship: 'Father', createPortalAccount: false },
  });

  const create = useMutation({
    mutationFn: (values: GuardianForm) =>
      post<GuardianRow & { temporaryPassword?: string }>('/parents', {
        ...values,
        altPhone: values.altPhone || null,
        email: values.email || null,
        occupation: values.occupation || null,
        address: values.address || null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['parents'] });
      setShowForm(false);
      form.reset({ relationship: 'Father', createPortalAccount: false });
      if (result.temporaryPassword) {
        setCredential({
          email: result.email ?? `${result.phone.replace(/\D/g, '')}@parents.local`,
          password: result.temporaryPassword,
        });
      }
    },
  });

  return (
    <>
      <PageHeader
        title="Parents & guardians"
        subtitle="Contact records, linked children and fee statements"
        actions={
          can('guardians:manage') && (
            <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
              Add parent
            </button>
          )
        }
      />

      <Card padded={false}>
        <div className="border-b border-slate-200 p-4">
          <input
            className="input sm:max-w-xs"
            placeholder="Search by name, phone or email"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search parents"
          />
        </div>

        {parents.isLoading ? (
          <Spinner />
        ) : parents.error ? (
          <div className="p-5">
            <ErrorNote error={parents.error} />
          </div>
        ) : parents.data?.data.length === 0 ? (
          <EmptyState title="No parents found" />
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Relationship</th>
                    <th>Phone</th>
                    <th>Children</th>
                    <th>Portal</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {parents.data?.data.map((p) => (
                    <tr key={p.id}>
                      <td className="font-medium text-slate-900">
                        {p.firstName} {p.lastName}
                        {p.email && <span className="block text-xs text-slate-400">{p.email}</span>}
                      </td>
                      <td>{p.relationship}</td>
                      <td className="font-mono text-xs">{p.phone}</td>
                      <td>
                        {p.studentLinks.length === 0 ? (
                          <span className="text-slate-400">None linked</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {p.studentLinks.map((link) => (
                              <li key={link.id}>
                                <Link
                                  to={`/students/${link.student.id}`}
                                  className="text-sm text-brand-700 hover:underline"
                                >
                                  {link.student.firstName} {link.student.lastName}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        {p.user ? (
                          <span className="badge bg-emerald-100 text-emerald-800">Active</span>
                        ) : (
                          <span className="badge bg-slate-100 text-slate-600">No login</span>
                        )}
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="text-sm text-brand-700 hover:underline"
                          onClick={() => setStatementFor(p.id)}
                        >
                          Fee statement
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {parents.data && (
              <Pagination
                page={parents.data.meta.page}
                totalPages={parents.data.meta.totalPages}
                total={parents.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      {showForm && (
        <Modal title="Add a parent or guardian" onClose={() => setShowForm(false)}>
          <form
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
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
              <Field label="Relationship" required>
                <select className="input" {...form.register('relationship', { required: true })}>
                  <option value="Father">Father</option>
                  <option value="Mother">Mother</option>
                  <option value="Guardian">Guardian</option>
                </select>
              </Field>
              <Field label="Phone" required hint="Used for SMS alerts.">
                <input className="input" placeholder="0754 000 000" {...form.register('phone', { required: true })} />
              </Field>
              <Field label="Alternate phone">
                <input className="input" {...form.register('altPhone')} />
              </Field>
              <Field label="Email">
                <input type="email" className="input" {...form.register('email')} />
              </Field>
              <Field label="Occupation">
                <input className="input" {...form.register('occupation')} />
              </Field>
              <Field label="Address">
                <input className="input" {...form.register('address')} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" {...form.register('createPortalAccount')} />
              Create a parent portal login
            </label>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Add parent'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {statementFor && (
        <Modal title="Fee statement" onClose={() => setStatementFor(null)} wide>
          {statement.isLoading ? (
            <Spinner />
          ) : statement.error ? (
            <ErrorNote error={statement.error} />
          ) : (
            <>
              <div className="mb-4">
                <p className="font-medium text-slate-900">
                  {statement.data?.guardian.firstName} {statement.data?.guardian.lastName}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs uppercase text-slate-500">Billed</p>
                    <p className="font-medium">{money(statement.data?.summary.totalBilled, currency)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-500">Paid</p>
                    <p className="font-medium">{money(statement.data?.summary.totalPaid, currency)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-500">Balance</p>
                    <p className="font-semibold text-slate-900">
                      {money(statement.data?.summary.balance, currency)}
                    </p>
                  </div>
                </div>
              </div>

              {statement.data?.invoices.length === 0 ? (
                <EmptyState title="No invoices for these children" />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Child</th>
                        <th className="text-right">Total</th>
                        <th className="text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.data?.invoices.map((inv) => (
                        <tr key={inv.id}>
                          <td className="font-mono text-xs">{inv.invoiceNumber}</td>
                          <td>
                            {inv.student.firstName} {inv.student.lastName}
                          </td>
                          <td className="text-right">{money(inv.total, currency)}</td>
                          <td className="text-right font-medium">{money(inv.balance, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </>
          )}
        </Modal>
      )}

      {credential && (
        <Modal title="Parent portal login created" onClose={() => setCredential(null)}>
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
