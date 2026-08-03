import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { del, get, post, qs } from '../lib/api';
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
import type { Guardian, Paginated, Student } from '../lib/types';

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

  const [linkingParent, setLinkingParent] = useState<GuardianRow | null>(null);
  const [studentSearch, setStudentSearch] = useState('');
  const [chosenStudent, setChosenStudent] = useState('');
  const [asPrimary, setAsPrimary] = useState(false);
  const [asFeePayer, setAsFeePayer] = useState(false);

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

  const studentResults = useQuery({
    queryKey: ['students', 'search', studentSearch],
    queryFn: () => get<Paginated<Student>>(`/students${qs({ search: studentSearch, pageSize: 10 })}`),
    enabled: Boolean(linkingParent) && studentSearch.trim().length >= 2,
  });

  const closeLinkModal = () => {
    setLinkingParent(null);
    setStudentSearch('');
    setChosenStudent('');
    setAsPrimary(false);
    setAsFeePayer(false);
  };

  /** Same endpoint the student page uses — the relationship has no direction. */
  const linkChild = useMutation({
    mutationFn: () =>
      post(`/students/${chosenStudent}/guardians`, {
        guardianId: linkingParent?.id,
        isPrimary: asPrimary,
        isFeePayer: asFeePayer,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['parents'] });
      void queryClient.invalidateQueries({ queryKey: ['student'] });
      closeLinkModal();
    },
  });

  const unlinkChild = useMutation({
    mutationFn: (vars: { studentId: string; guardianId: string }) =>
      del(`/students/${vars.studentId}/guardians/${vars.guardianId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['parents'] });
      void queryClient.invalidateQueries({ queryKey: ['student'] });
    },
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

      {unlinkChild.error != null && (
        <div className="mb-4">
          <ErrorNote error={unlinkChild.error} />
        </div>
      )}

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
                              <li key={link.id} className="flex items-center gap-2">
                                <Link
                                  to={`/students/${link.student.id}`}
                                  className="text-sm text-brand-700 hover:underline"
                                >
                                  {link.student.firstName} {link.student.lastName}
                                </Link>
                                {can('guardians:manage') && (
                                  <button
                                    type="button"
                                    className="text-xs text-slate-400 hover:text-red-700 disabled:opacity-50"
                                    disabled={unlinkChild.isPending}
                                    title={`Unlink ${link.student.firstName} from ${p.firstName}`}
                                    aria-label={`Unlink ${link.student.firstName} ${link.student.lastName} from ${p.firstName} ${p.lastName}`}
                                    onClick={() =>
                                      unlinkChild.mutate({
                                        studentId: link.student.id,
                                        guardianId: p.id,
                                      })
                                    }
                                  >
                                    ✕
                                  </button>
                                )}
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
                      <td className="whitespace-nowrap text-right">
                        {can('guardians:manage') && (
                          <button
                            type="button"
                            className="mr-3 text-sm text-brand-700 hover:underline"
                            onClick={() => setLinkingParent(p)}
                          >
                            Link child
                          </button>
                        )}
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

      {linkingParent && (
        <Modal
          title={`Link a child to ${linkingParent.firstName} ${linkingParent.lastName}`}
          onClose={closeLinkModal}
        >
          {linkChild.error != null && (
            <div className="mb-4">
              <ErrorNote error={linkChild.error} />
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="student-search">
                Find the student
              </label>
              <input
                id="student-search"
                className="input"
                autoFocus
                placeholder="Name or admission number"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
              />
            </div>

            {studentSearch.trim().length >= 2 && (
              <div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200">
                {studentResults.isLoading ? (
                  <Spinner label="Searching…" />
                ) : studentResults.data?.data.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No students match that search.</p>
                ) : (
                  <ul>
                    {studentResults.data?.data.map((s) => (
                      <li key={s.id}>
                        <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm last:border-0 hover:bg-slate-50">
                          <input
                            type="radio"
                            name="student"
                            value={s.id}
                            checked={chosenStudent === s.id}
                            onChange={() => setChosenStudent(s.id)}
                          />
                          <span>
                            <span className="font-medium">
                              {s.firstName} {s.lastName}
                            </span>
                            <span className="block text-xs text-slate-400">
                              {s.admissionNumber}
                              {s.enrollments[0] ? ` · ${s.enrollments[0].schoolClass.name}` : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={asPrimary}
                  onChange={(e) => setAsPrimary(e.target.checked)}
                />
                Primary contact for this child
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={asFeePayer}
                  onChange={(e) => setAsFeePayer(e.target.checked)}
                />
                Responsible for this child's fees
              </label>
              <p className="text-xs text-slate-500">
                Each child has one primary contact and one fee payer — setting these moves them from
                whoever holds them now.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={closeLinkModal}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!chosenStudent || linkChild.isPending}
                onClick={() => linkChild.mutate()}
              >
                {linkChild.isPending ? 'Linking…' : 'Link child'}
              </button>
            </div>
          </div>
        </Modal>
      )}

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
