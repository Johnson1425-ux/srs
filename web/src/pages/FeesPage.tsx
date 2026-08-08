import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { download, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { AcademicYear, SchoolClass } from '../lib/types';

const CATEGORIES = [
  'TUITION',
  'TRANSPORT',
  'MEALS',
  'BOARDING',
  'UNIFORM',
  'EXAMINATION',
  'REGISTRATION',
  'LIBRARY',
  'OTHER',
] as const;

interface FeeStructure {
  id: string;
  name: string;
  isActive: boolean;
  schoolClass: { id: string; name: string } | null;
  term: { id: string; name: string } | null;
  academicYear: { id: string; name: string };
  items: Array<{ id: string; category: string; name: string; amount: string }>;
}

interface OutstandingRow {
  id: string;
  invoiceNumber: string;
  dueDate: string;
  total: string;
  amountPaid: string;
  balance: string;
  student: {
    id: string;
    admissionNumber: string;
    firstName: string;
    lastName: string;
    enrollments: Array<{ schoolClass: { name: string } }>;
  };
}

interface StructureForm {
  academicYearId: string;
  termId: string;
  classId: string;
  name: string;
  items: Array<{ category: string; name: string; amount: number }>;
}

export function FeesPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [tab, setTab] = useState<'structures' | 'outstanding'>('structures');
  const [showForm, setShowForm] = useState(false);
  const [billing, setBilling] = useState<FeeStructure | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const years = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => get<{ data: AcademicYear[] }>('/academics/years'),
  });
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });
  const structures = useQuery({
    queryKey: ['fee-structures'],
    queryFn: () => get<{ data: FeeStructure[] }>('/fees/structures'),
  });
  const outstanding = useQuery({
    queryKey: ['fees', 'outstanding'],
    queryFn: () =>
      get<{ data: OutstandingRow[]; totalOutstanding: string; meta: { total: number } }>(
        '/fees/outstanding?pageSize=100',
      ),
    enabled: tab === 'outstanding',
  });

  const form = useForm<StructureForm>({
    defaultValues: { items: [{ category: 'TUITION', name: 'Tuition', amount: 0 }] },
  });
  const items = useFieldArray({ control: form.control, name: 'items' });
  const selectedYear = years.data?.data.find((y) => y.id === form.watch('academicYearId'));

  const createStructure = useMutation({
    mutationFn: (values: StructureForm) =>
      post<FeeStructure>('/fees/structures', {
        academicYearId: values.academicYearId,
        termId: values.termId || null,
        classId: values.classId || null,
        name: values.name,
        items: values.items.map((i) => ({ ...i, amount: Number(i.amount) })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fee-structures'] });
      setShowForm(false);
      form.reset({ items: [{ category: 'TUITION', name: 'Tuition', amount: 0 }] });
    },
  });

  const generate = useMutation({
    mutationFn: (structureId: string) =>
      post<{ generated: number; skipped: number }>(
        `/fees/structures/${structureId}/generate-invoices`,
        { dueDate },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['fees'] });
      setBilling(null);
      setDueDate('');
      setNotice(
        `${result.generated} invoice(s) generated` +
          (result.skipped ? ` · ${result.skipped} student(s) already billed` : ''),
      );
    },
  });

  return (
    <>
      <PageHeader
        title="Fees"
        subtitle="Fee structures, invoicing and outstanding balances"
        actions={
          can('fees:manage') && (
            <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
              New fee structure
            </button>
          )
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(['structures', 'outstanding'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t === 'structures' ? 'Fee structures' : 'Outstanding balances'}
          </button>
        ))}
      </div>

      {tab === 'structures' && (
        <>
          {structures.isLoading ? (
            <Spinner />
          ) : structures.error ? (
            <ErrorNote error={structures.error} />
          ) : structures.data?.data.length === 0 ? (
            <Card>
              <EmptyState
                title="No fee structures yet"
                hint="Create one to define what each class is billed per term."
              />
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {structures.data?.data.map((structure) => {
                const total = structure.items.reduce((acc, i) => acc + Number(i.amount), 0);
                return (
                  <Card key={structure.id} title={structure.name} padded={false}>
                    <div className="border-b border-slate-200 px-5 py-2 text-xs text-slate-500">
                      {structure.academicYear.name}
                      {structure.term ? ` · ${structure.term.name}` : ''}
                      {structure.schoolClass ? ` · ${structure.schoolClass.name}` : ' · All classes'}
                    </div>
                    <TableWrap>
                      <table className="table">
                        <tbody>
                          {structure.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.name}</td>
                              <td className="text-right">{money(item.amount, currency)}</td>
                            </tr>
                          ))}
                          <tr>
                            <td className="font-semibold">Total per student</td>
                            <td className="text-right font-semibold">{money(total, currency)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </TableWrap>
                    {can('fees:manage') && (
                      <div className="border-t border-slate-200 px-5 py-3 text-right">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setBilling(structure)}
                        >
                          Generate invoices
                        </button>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'outstanding' && (
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-slate-200 p-4">
            <p className="text-sm text-slate-600">
              Total outstanding:{' '}
              <strong className="text-slate-900">
                {money(outstanding.data?.totalOutstanding, currency)}
              </strong>
            </p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                download(`/reports/outstanding-fees${qs({ format: 'csv' })}`, 'outstanding-fees.csv')
              }
            >
              Export CSV
            </button>
          </div>
          {outstanding.isLoading ? (
            <Spinner />
          ) : outstanding.error ? (
            <div className="p-5">
              <ErrorNote error={outstanding.error} />
            </div>
          ) : outstanding.data?.data.length === 0 ? (
            <EmptyState title="No outstanding balances" hint="Every issued invoice is settled." />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Student</th>
                    <th>Class</th>
                    <th>Due</th>
                    <th className="text-right">Billed</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Balance</th>
                    {can('payments:create') && <th />}
                  </tr>
                </thead>
                <tbody>
                  {outstanding.data?.data.map((row) => {
                    const overdue = new Date(row.dueDate) < new Date();
                    return (
                      <tr key={row.id}>
                        <td className="font-mono text-xs">{row.invoiceNumber}</td>
                        <td>
                          {row.student.firstName} {row.student.lastName}
                          <span className="block text-xs text-slate-400">
                            {row.student.admissionNumber}
                          </span>
                        </td>
                        <td>{row.student.enrollments[0]?.schoolClass.name ?? '—'}</td>
                        <td className={overdue ? 'font-medium text-red-700' : ''}>
                          {date(row.dueDate)}
                        </td>
                        <td className="text-right">{money(row.total, currency)}</td>
                        <td className="text-right">{money(row.amountPaid, currency)}</td>
                        <td className="text-right font-semibold">{money(row.balance, currency)}</td>
                        {can('payments:create') && (
                          <td className="text-right">
                            {/* Whoever is reading this list is looking at who owes
                                money, so let them take it here rather than making
                                them carry a name across to the payments page. */}
                            <Link
                              className="link whitespace-nowrap"
                              to={`/payments${qs({
                                studentId: row.student.id,
                                admissionNumber: row.student.admissionNumber,
                              })}`}
                            >
                              Record payment
                            </Link>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {showForm && (
        <Modal title="New fee structure" onClose={() => setShowForm(false)} wide>
          <form
            onSubmit={form.handleSubmit((values) => createStructure.mutate(values))}
            className="space-y-5"
            noValidate
          >
            {createStructure.error != null && <ErrorNote error={createStructure.error} />}

            <div className="grid gap-4 sm:grid-cols-2">
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
                  <option value="">Whole year</option>
                  {selectedYear?.terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Class" hint="Leave blank to apply to every class.">
                <select className="input" {...form.register('classId')}>
                  <option value="">All classes</option>
                  {classes.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Structure name" required>
                <input
                  className="input"
                  placeholder="Form 1 — Term 2 2026"
                  {...form.register('name', { required: true })}
                />
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Fee items</h3>
                <button
                  type="button"
                  className="btn-secondary px-3 py-1 text-xs"
                  onClick={() => items.append({ category: 'OTHER', name: '', amount: 0 })}
                >
                  Add item
                </button>
              </div>
              <div className="space-y-3">
                {items.fields.map((field, index) => (
                  <div key={field.id} className="grid gap-2 sm:grid-cols-[1fr_1.5fr_1fr_auto]">
                    <select className="input" {...form.register(`items.${index}.category` as const)}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c.charAt(0) + c.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input"
                      placeholder="Description"
                      {...form.register(`items.${index}.name` as const, { required: true })}
                    />
                    <input
                      type="number"
                      min={0}
                      step={100}
                      className="input"
                      placeholder="Amount"
                      {...form.register(`items.${index}.amount` as const, {
                        required: true,
                        valueAsNumber: true,
                      })}
                    />
                    <button
                      type="button"
                      className="btn-secondary px-3"
                      onClick={() => items.remove(index)}
                      disabled={items.fields.length === 1}
                      aria-label="Remove item"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createStructure.isPending}>
                {createStructure.isPending ? 'Saving…' : 'Create structure'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {billing && (
        <Modal title={`Generate invoices — ${billing.name}`} onClose={() => setBilling(null)}>
          {generate.error != null && (
            <div className="mb-4">
              <ErrorNote error={generate.error} />
            </div>
          )}
          <p className="mb-4 text-sm text-slate-600">
            Every active student in{' '}
            <strong>{billing.schoolClass?.name ?? 'the whole school'}</strong> will be invoiced.
            Students already billed for this term are skipped.
          </p>
          <Field label="Payment due date" required>
            <input
              type="date"
              className="input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setBilling(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!dueDate || generate.isPending}
              onClick={() => generate.mutate(billing.id)}
            >
              {generate.isPending ? 'Generating…' : 'Generate invoices'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
