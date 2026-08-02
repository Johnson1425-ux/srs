import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, isoDate, money } from '../lib/format';
import {
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

interface LedgerEntry {
  id: string;
  entryType: 'INCOME' | 'EXPENSE';
  category: string;
  description: string;
  amount: string;
  entryDate: string;
  reference: string | null;
}

interface ProfitLoss {
  income: Array<{ category: string; amount: string }>;
  expenses: Array<{ category: string; amount: string }>;
  totals: { income: string; expenses: string; netSurplus: string };
}

interface PayrollRun {
  id: string;
  period: string;
  status: string;
  grossTotal: string;
  netTotal: string;
  _count: { payslips: number };
}

interface LedgerForm {
  entryType: 'INCOME' | 'EXPENSE';
  category: string;
  description: string;
  amount: number;
  entryDate: string;
  reference?: string;
}

const yearStart = `${new Date().getFullYear()}-01-01`;

export function AccountingPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [tab, setTab] = useState<'summary' | 'ledger' | 'payroll'>('summary');
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(isoDate());
  const [showEntry, setShowEntry] = useState(false);
  const [showPayroll, setShowPayroll] = useState(false);

  const range = qs({ from, to });

  const pl = useQuery({
    queryKey: ['accounting', 'pl', range],
    queryFn: () => get<ProfitLoss>(`/accounting/profit-loss${range}`),
    enabled: tab === 'summary',
  });

  const ledger = useQuery({
    queryKey: ['accounting', 'ledger', range],
    queryFn: () =>
      get<{ data: LedgerEntry[]; meta: { total: number } }>(
        `/accounting/ledger${qs({ from, to, pageSize: 100 })}`,
      ),
    enabled: tab === 'ledger',
  });

  const payroll = useQuery({
    queryKey: ['payroll'],
    queryFn: () => get<{ data: PayrollRun[] }>('/accounting/payroll'),
    enabled: tab === 'payroll',
  });

  const entryForm = useForm<LedgerForm>({
    defaultValues: { entryType: 'EXPENSE', entryDate: isoDate() },
  });

  const createEntry = useMutation({
    mutationFn: (values: LedgerForm) =>
      post('/accounting/ledger', {
        ...values,
        amount: Number(values.amount),
        reference: values.reference || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounting'] });
      setShowEntry(false);
      entryForm.reset({ entryType: 'EXPENSE', entryDate: isoDate() });
    },
  });

  const payrollForm = useForm<{ period: string; allowances: number }>({
    defaultValues: { period: isoDate().slice(0, 7), allowances: 0 },
  });

  const runPayroll = useMutation({
    mutationFn: (values: { period: string; allowances: number }) =>
      post('/accounting/payroll', { period: values.period, allowances: Number(values.allowances) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payroll'] });
      void queryClient.invalidateQueries({ queryKey: ['accounting'] });
      setShowPayroll(false);
    },
  });

  return (
    <>
      <PageHeader
        title="Accounting"
        subtitle="General ledger, financial statements and payroll"
        actions={
          <>
            {can('accounting:manage') && (
              <button type="button" className="btn-secondary" onClick={() => setShowEntry(true)}>
                Record entry
              </button>
            )}
            {can('payroll:manage') && (
              <button type="button" className="btn-primary" onClick={() => setShowPayroll(true)}>
                Run payroll
              </button>
            )}
          </>
        }
      />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="acc-from">
              From
            </label>
            <input
              id="acc-from"
              type="date"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="acc-to">
              To
            </label>
            <input
              id="acc-to"
              type="date"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
      </Card>

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(
          [
            ['summary', 'Profit & loss'],
            ['ledger', 'General ledger'],
            ['payroll', 'Payroll'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' &&
        (pl.isLoading ? (
          <Spinner />
        ) : pl.error ? (
          <ErrorNote error={pl.error} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="Total income" value={money(pl.data?.totals.income, currency)} tone="emerald" />
              <StatTile label="Total expenses" value={money(pl.data?.totals.expenses, currency)} tone="red" />
              <StatTile
                label="Net surplus"
                value={money(pl.data?.totals.netSurplus, currency)}
                tone={Number(pl.data?.totals.netSurplus ?? 0) >= 0 ? 'emerald' : 'red'}
              />
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card title="Income by category" padded={false}>
                {pl.data?.income.length === 0 ? (
                  <EmptyState title="No income in this period" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <tbody>
                        {pl.data?.income.map((row) => (
                          <tr key={row.category}>
                            <td>{row.category}</td>
                            <td className="text-right font-medium">{money(row.amount, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>

              <Card title="Expenses by category" padded={false}>
                {pl.data?.expenses.length === 0 ? (
                  <EmptyState title="No expenses in this period" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <tbody>
                        {pl.data?.expenses.map((row) => (
                          <tr key={row.category}>
                            <td>{row.category}</td>
                            <td className="text-right font-medium">{money(row.amount, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>
            </div>
          </>
        ))}

      {tab === 'ledger' && (
        <Card padded={false}>
          {ledger.isLoading ? (
            <Spinner />
          ) : ledger.data?.data.length === 0 ? (
            <EmptyState title="No ledger entries in this period" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Reference</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data?.data.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap">{date(e.entryDate)}</td>
                      <td>
                        <span
                          className={`badge ${
                            e.entryType === 'INCOME'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {e.entryType === 'INCOME' ? 'Income' : 'Expense'}
                        </span>
                      </td>
                      <td>{e.category}</td>
                      <td className="text-slate-600">{e.description}</td>
                      <td className="font-mono text-xs text-slate-500">{e.reference ?? '—'}</td>
                      <td className="text-right font-medium">{money(e.amount, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {tab === 'payroll' && (
        <Card padded={false}>
          {payroll.isLoading ? (
            <Spinner />
          ) : payroll.data?.data.length === 0 ? (
            <EmptyState title="No payroll runs yet" hint="Run payroll for a month to generate payslips." />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Payslips</th>
                    <th className="text-right">Gross</th>
                    <th className="text-right">Net</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payroll.data?.data.map((run) => (
                    <tr key={run.id}>
                      <td className="font-medium">{run.period}</td>
                      <td>{run._count.payslips}</td>
                      <td className="text-right">{money(run.grossTotal, currency)}</td>
                      <td className="text-right font-medium">{money(run.netTotal, currency)}</td>
                      <td>{run.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {showEntry && (
        <Modal title="Record a ledger entry" onClose={() => setShowEntry(false)}>
          <form
            onSubmit={entryForm.handleSubmit((v) => createEntry.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {createEntry.error != null && <ErrorNote error={createEntry.error} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type" required>
                <select className="input" {...entryForm.register('entryType', { required: true })}>
                  <option value="EXPENSE">Expense</option>
                  <option value="INCOME">Income</option>
                </select>
              </Field>
              <Field label="Category" required>
                <input
                  className="input"
                  placeholder="Utilities, Supplies…"
                  {...entryForm.register('category', { required: true })}
                />
              </Field>
              <Field label="Amount" required>
                <input
                  type="number"
                  min={1}
                  step={100}
                  className="input"
                  {...entryForm.register('amount', { required: true, valueAsNumber: true })}
                />
              </Field>
              <Field label="Date" required>
                <input type="date" className="input" {...entryForm.register('entryDate', { required: true })} />
              </Field>
            </div>
            <Field label="Description" required>
              <input className="input" {...entryForm.register('description', { required: true })} />
            </Field>
            <Field label="Reference">
              <input className="input" placeholder="Invoice or voucher number" {...entryForm.register('reference')} />
            </Field>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowEntry(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createEntry.isPending}>
                Record entry
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showPayroll && (
        <Modal title="Run monthly payroll" onClose={() => setShowPayroll(false)}>
          <form
            onSubmit={payrollForm.handleSubmit((v) => runPayroll.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {runPayroll.error != null && <ErrorNote error={runPayroll.error} />}
            <p className="text-sm text-slate-600">
              Generates payslips for every active staff member with a basic salary, applies NSSF and
              PAYE, and posts the total to the ledger.
            </p>
            <Field label="Period" required hint="Format: YYYY-MM">
              <input className="input" placeholder="2026-08" {...payrollForm.register('period', { required: true })} />
            </Field>
            <Field label="Standard allowance" hint="Applied to every payslip.">
              <input
                type="number"
                min={0}
                step={1000}
                className="input"
                {...payrollForm.register('allowances', { valueAsNumber: true })}
              />
            </Field>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowPayroll(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={runPayroll.isPending}>
                {runPayroll.isPending ? 'Running…' : 'Run payroll'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
