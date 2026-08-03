import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { del, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, isoDate, money } from '../lib/format';
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
  approvedAt: string | null;
  paidAt: string | null;
  _count: { payslips: number };
}

interface PayslipRow {
  id: string;
  basicSalary: string;
  allowances: string;
  grossPay: string;
  payeTax: string;
  nssf: string;
  otherDeductions: string;
  netPay: string;
  staff: {
    id: string;
    firstName: string;
    lastName: string;
    staffNumber: string;
    jobTitle: string | null;
    bankName: string | null;
    bankAccount: string | null;
  };
}

interface RunDetail extends PayrollRun {
  payslips: PayslipRow[];
}

interface PayslipDetail {
  school: { name: string; address: string | null; phone: string | null; currency: string };
  period: string;
  status: string;
  paidAt: string | null;
  staff: {
    firstName: string;
    lastName: string;
    staffNumber: string;
    jobTitle: string | null;
    bankName: string | null;
    bankAccount: string | null;
    department: { name: string } | null;
  };
  earnings: Array<{ label: string; amount: string }>;
  deductions: Array<{ label: string; amount: string }>;
  totals: {
    gross: string;
    grossFormatted: string;
    totalDeductions: string;
    net: string;
    netFormatted: string;
  };
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
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openPayslipId, setOpenPayslipId] = useState<string | null>(null);

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

  const runDetail = useQuery({
    queryKey: ['payroll', openRunId],
    queryFn: () => get<RunDetail>(`/accounting/payroll/${openRunId}`),
    enabled: Boolean(openRunId),
  });

  const payslipDetail = useQuery({
    queryKey: ['payroll', openRunId, 'payslip', openPayslipId],
    queryFn: () =>
      get<PayslipDetail>(`/accounting/payroll/${openRunId}/payslips/${openPayslipId}`),
    enabled: Boolean(openRunId && openPayslipId),
  });

  const refreshPayroll = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll'] });
    void queryClient.invalidateQueries({ queryKey: ['accounting'] });
  };

  const approveRun = useMutation({
    mutationFn: (runId: string) => post(`/accounting/payroll/${runId}/approve`),
    onSuccess: refreshPayroll,
  });

  const markPaid = useMutation({
    mutationFn: (runId: string) => post(`/accounting/payroll/${runId}/mark-paid`, {}),
    onSuccess: refreshPayroll,
  });

  const discardDraft = useMutation({
    mutationFn: (runId: string) => del(`/accounting/payroll/${runId}`),
    onSuccess: () => {
      refreshPayroll();
      setOpenRunId(null);
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
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {payroll.data?.data.map((run) => (
                    <tr key={run.id}>
                      <td className="font-medium">{run.period}</td>
                      <td>{run._count.payslips}</td>
                      <td className="text-right">{money(run.grossTotal, currency)}</td>
                      <td className="text-right font-medium">{money(run.netTotal, currency)}</td>
                      <td>
                        <Badge status={run.status} />
                        {run.paidAt && (
                          <span className="ml-2 text-xs text-slate-400">{date(run.paidAt)}</span>
                        )}
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="text-sm text-brand-700 hover:underline"
                          onClick={() => setOpenRunId(run.id)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {openRunId && !openPayslipId && (
        <Modal title="Payroll run" onClose={() => setOpenRunId(null)} wide>
          {runDetail.isLoading ? (
            <Spinner />
          ) : runDetail.error ? (
            <ErrorNote error={runDetail.error} />
          ) : runDetail.data ? (
            <>
              {(approveRun.error ?? markPaid.error ?? discardDraft.error) != null && (
                <div className="mb-4">
                  <ErrorNote error={approveRun.error ?? markPaid.error ?? discardDraft.error} />
                </div>
              )}

              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-900">{runDetail.data.period}</p>
                  <p className="text-sm text-slate-500">
                    {runDetail.data.payslips.length} payslip(s) ·{' '}
                    {money(runDetail.data.netTotal, currency)} net
                  </p>
                </div>
                <Badge status={runDetail.data.status} />
              </div>

              <ol className="mb-5 flex flex-wrap gap-2 text-xs">
                {(['DRAFT', 'APPROVED', 'PAID'] as const).map((stage, i) => {
                  const order = ['DRAFT', 'APPROVED', 'PAID'];
                  const reached = order.indexOf(runDetail.data!.status) >= i;
                  return (
                    <li
                      key={stage}
                      className={`rounded-md px-2.5 py-1 ${
                        reached ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {i + 1}. {stage.charAt(0) + stage.slice(1).toLowerCase()}
                    </li>
                  );
                })}
              </ol>

              {runDetail.data.status === 'DRAFT' && (
                <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  This is a draft. Nothing has been posted to the ledger yet — approving it books
                  the salary expense.
                </p>
              )}

              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th className="text-right">Gross</th>
                      <th className="text-right">NSSF</th>
                      <th className="text-right">PAYE</th>
                      <th className="text-right">Net</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {runDetail.data.payslips.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.staff.firstName} {p.staff.lastName}
                          <span className="block text-xs text-slate-400">
                            {p.staff.staffNumber}
                            {p.staff.jobTitle ? ` · ${p.staff.jobTitle}` : ''}
                          </span>
                        </td>
                        <td className="text-right">{money(p.grossPay, currency)}</td>
                        <td className="text-right text-slate-500">{money(p.nssf, currency)}</td>
                        <td className="text-right text-slate-500">{money(p.payeTax, currency)}</td>
                        <td className="text-right font-medium">{money(p.netPay, currency)}</td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="text-sm text-brand-700 hover:underline"
                            onClick={() => setOpenPayslipId(p.id)}
                          >
                            Payslip
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>

              {can('payroll:manage') && (
                <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
                  {runDetail.data.status === 'DRAFT' && (
                    <>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={discardDraft.isPending}
                        onClick={() => discardDraft.mutate(runDetail.data!.id)}
                      >
                        Discard draft
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={approveRun.isPending}
                        onClick={() => approveRun.mutate(runDetail.data!.id)}
                      >
                        {approveRun.isPending ? 'Approving…' : 'Approve run'}
                      </button>
                    </>
                  )}
                  {runDetail.data.status === 'APPROVED' && (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={markPaid.isPending}
                      onClick={() => markPaid.mutate(runDetail.data!.id)}
                    >
                      {markPaid.isPending ? 'Saving…' : 'Mark as paid'}
                    </button>
                  )}
                  {runDetail.data.status === 'PAID' && (
                    <p className="text-sm text-slate-500">
                      Paid {runDetail.data.paidAt ? dateTime(runDetail.data.paidAt) : ''}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : null}
        </Modal>
      )}

      {openPayslipId && (
        <Modal title="Payslip" onClose={() => setOpenPayslipId(null)}>
          {payslipDetail.isLoading ? (
            <Spinner />
          ) : payslipDetail.error ? (
            <ErrorNote error={payslipDetail.error} />
          ) : payslipDetail.data ? (
            <>
              <div className="space-y-4 text-sm">
                <div className="border-b border-slate-200 pb-4 text-center">
                  <h3 className="text-lg font-semibold text-slate-900">
                    {payslipDetail.data.school.name}
                  </h3>
                  {payslipDetail.data.school.address && (
                    <p className="text-xs text-slate-500">{payslipDetail.data.school.address}</p>
                  )}
                  <p className="mt-3 font-medium uppercase tracking-wide text-slate-700">
                    Payslip — {payslipDetail.data.period}
                  </p>
                  {payslipDetail.data.status !== 'PAID' && (
                    <p className="mt-1 text-xs text-amber-700">
                      {payslipDetail.data.status === 'DRAFT'
                        ? 'Draft — not yet approved'
                        : 'Approved — payment pending'}
                    </p>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-3">
                  <Cell
                    label="Employee"
                    value={`${payslipDetail.data.staff.firstName} ${payslipDetail.data.staff.lastName}`}
                  />
                  <Cell label="Staff number" value={payslipDetail.data.staff.staffNumber} mono />
                  <Cell label="Position" value={payslipDetail.data.staff.jobTitle ?? '—'} />
                  <Cell
                    label="Department"
                    value={payslipDetail.data.staff.department?.name ?? '—'}
                  />
                </dl>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Earnings
                    </p>
                    <ul className="space-y-1">
                      {payslipDetail.data.earnings.map((e) => (
                        <li key={e.label} className="flex justify-between text-slate-700">
                          <span>{e.label}</span>
                          <span>{money(e.amount, currency)}</span>
                        </li>
                      ))}
                      <li className="flex justify-between border-t border-slate-200 pt-1 font-medium">
                        <span>Gross</span>
                        <span>{money(payslipDetail.data.totals.gross, currency)}</span>
                      </li>
                    </ul>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Deductions
                    </p>
                    <ul className="space-y-1">
                      {payslipDetail.data.deductions.map((d) => (
                        <li key={d.label} className="flex justify-between text-slate-700">
                          <span>{d.label}</span>
                          <span>{money(d.amount, currency)}</span>
                        </li>
                      ))}
                      <li className="flex justify-between border-t border-slate-200 pt-1 font-medium">
                        <span>Total</span>
                        <span>{money(payslipDetail.data.totals.totalDeductions, currency)}</span>
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-baseline justify-between border-t border-slate-200 pt-4">
                  <span className="font-medium text-slate-700">Net pay</span>
                  <span className="text-xl font-semibold text-slate-900">
                    {payslipDetail.data.totals.netFormatted}
                  </span>
                </div>

                {payslipDetail.data.staff.bankAccount && (
                  <p className="text-xs text-slate-500">
                    Paid to {payslipDetail.data.staff.bankName} ·{' '}
                    {payslipDetail.data.staff.bankAccount}
                  </p>
                )}
              </div>

              <div className="mt-6 flex justify-end gap-2 print:hidden">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setOpenPayslipId(null)}
                >
                  Back to run
                </button>
                <button type="button" className="btn-primary" onClick={() => window.print()}>
                  Print
                </button>
              </div>
            </>
          ) : null}
        </Modal>
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

function Cell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
