import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { download, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, isoDate, money, titleCase } from '../lib/format';
import {
  ActionMenu,
  Badge,
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
import type { Paginated, Payment, Student } from '../lib/types';

const METHODS = ['CASH', 'MOBILE_MONEY', 'BANK', 'CARD', 'ONLINE'] as const;
const PROVIDERS = ['MPESA', 'AIRTEL_MONEY', 'MIXX_BY_YAS', 'HALOPESA'] as const;

interface PaymentForm {
  studentId: string;
  amount: number;
  method: (typeof METHODS)[number];
  provider?: string;
  reference?: string;
  payerName?: string;
  paidAt: string;
  note?: string;
}

interface Receipt {
  school: { name: string; address: string | null; phone: string | null; currency: string };
  receipt: {
    number: string;
    date: string;
    method: string;
    provider: string | null;
    reference: string | null;
    payerName: string | null;
    amountFormatted: string;
    status: string;
  };
  student: { name: string; admissionNumber: string; className: string | null; streamName: string | null };
  allocations: Array<{ invoiceNumber: string; amount: string; invoiceBalance: string }>;
  outstandingAfter: string;
}

export function PaymentsPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [page, setPage] = useState(1);
  const [method, setMethod] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [reason, setReason] = useState('');

  const query = qs({ page, pageSize: 25, method });
  const payments = useQuery({
    queryKey: ['payments', query],
    queryFn: () => get<Paginated<Payment> & { totalCollected: string }>(`/payments${query}`),
  });

  const studentSearch = useQuery({
    queryKey: ['students', 'search', search],
    queryFn: () => get<Paginated<Student>>(`/students${qs({ search, pageSize: 10 })}`),
    enabled: showForm && search.length >= 2,
  });

  const form = useForm<PaymentForm>({
    defaultValues: { method: 'MOBILE_MONEY', paidAt: isoDate() },
  });
  const selectedMethod = form.watch('method');
  const selectedStudentId = form.watch('studentId');
  const selectedStudent = studentSearch.data?.data.find((s) => s.id === selectedStudentId);

  const balance = useQuery({
    queryKey: ['fees', 'balance', selectedStudentId],
    queryFn: () =>
      get<{ summary: { balance: string; totalBilled: string } }>(
        `/fees/students/${selectedStudentId}/balance`,
      ),
    enabled: Boolean(selectedStudentId),
  });

  const record = useMutation({
    mutationFn: (values: PaymentForm) =>
      post<{ payment: Payment; allocated: string; unallocated: string }>('/payments', {
        studentId: values.studentId,
        amount: Number(values.amount),
        method: values.method,
        provider: values.method === 'MOBILE_MONEY' ? values.provider || null : null,
        reference: values.reference || null,
        payerName: values.payerName || null,
        paidAt: values.paidAt,
        note: values.note || null,
      }),
    onSuccess: async (result) => {
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['fees'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setShowForm(false);
      form.reset({ method: 'MOBILE_MONEY', paidAt: isoDate() });
      setSearch('');
      // Straight to the printable receipt — the counter workflow.
      setReceipt(await get<Receipt>(`/payments/${result.payment.id}/receipt`));
    },
  });

  const [receiptError, setReceiptError] = useState<unknown>(null);

  /** Menu items are synchronous, so the fetch is kicked off rather than awaited. */
  const openReceipt = (paymentId: string) => {
    setReceiptError(null);
    void get<Receipt>(`/payments/${paymentId}/receipt`)
      .then(setReceipt)
      .catch(setReceiptError);
  };

  const reverse = useMutation({
    mutationFn: (paymentId: string) => post(`/payments/${paymentId}/reverse`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['fees'] });
      setReversing(null);
      setReason('');
    },
  });

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Fee collection, receipts and reversals"
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                download(
                  `/reports/fee-collection${qs({
                    from: `${new Date().getFullYear()}-01-01`,
                    to: isoDate(),
                    format: 'csv',
                  })}`,
                  'fee-collection.csv',
                )
              }
            >
              Export CSV
            </button>
            {can('payments:create') && (
              <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
                Record payment
              </button>
            )}
          </>
        }
      />

      {receiptError != null && (
        <div className="mb-4">
          <ErrorNote error={receiptError} />
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <select
            className="input sm:max-w-[200px]"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by payment method"
          >
            <option value="">All methods</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {titleCase(m)}
              </option>
            ))}
          </select>
          <p className="text-sm text-slate-600">
            Collected:{' '}
            <strong className="text-slate-900">
              {money(payments.data?.totalCollected, currency)}
            </strong>
          </p>
        </div>

        {payments.isLoading ? (
          <Spinner />
        ) : payments.error ? (
          <div className="p-5">
            <ErrorNote error={payments.error} />
          </div>
        ) : payments.data?.data.length === 0 ? (
          <EmptyState title="No payments recorded" />
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Date</th>
                    <th>Student</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th className="text-right">Amount</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {payments.data?.data.map((p) => (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.receiptNumber}</td>
                      <td>{date(p.paidAt)}</td>
                      <td>
                        {p.student?.firstName} {p.student?.lastName}
                        <span className="block text-xs text-slate-400">
                          {p.student?.admissionNumber}
                        </span>
                      </td>
                      <td className="text-xs">
                        {titleCase(p.method)}
                        {p.provider && (
                          <span className="block text-slate-400">{titleCase(p.provider)}</span>
                        )}
                      </td>
                      <td className="font-mono text-xs text-slate-500">{p.reference ?? '—'}</td>
                      <td className="text-right font-medium">{money(p.amount, currency)}</td>
                      <td>
                        <Badge status={p.status} />
                      </td>
                      <td className="w-12 text-right">
                        <ActionMenu
                          label={`Actions for receipt ${p.receiptNumber}`}
                          items={[
                            { label: 'View receipt', onClick: () => openReceipt(p.id) },
                            ...(can('payments:reverse') && p.status === 'CONFIRMED'
                              ? [
                                  {
                                    label: 'Reverse payment',
                                    danger: true,
                                    onClick: () => setReversing(p),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {payments.data && (
              <Pagination
                page={payments.data.meta.page}
                totalPages={payments.data.meta.totalPages}
                total={payments.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      {showForm && (
        <Modal title="Record a fee payment" onClose={() => setShowForm(false)}>
          <form
            onSubmit={form.handleSubmit((values) => record.mutate(values))}
            className="space-y-4"
            noValidate
          >
            {record.error != null && <ErrorNote error={record.error} />}

            <Field label="Find the student" required hint="Search by name or admission number.">
              <input
                className="input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Start typing…"
                autoFocus
              />
            </Field>

            {search.length >= 2 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
                {studentSearch.isLoading ? (
                  <Spinner label="Searching…" />
                ) : studentSearch.data?.data.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No students match that search.</p>
                ) : (
                  <ul>
                    {studentSearch.data?.data.map((s) => (
                      <li key={s.id}>
                        <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm last:border-0 hover:bg-slate-50">
                          <input
                            type="radio"
                            value={s.id}
                            {...form.register('studentId', { required: true })}
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

            {selectedStudent && balance.data && (
              <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
                <p className="font-medium text-slate-800">
                  {selectedStudent.firstName} {selectedStudent.lastName}
                </p>
                <p className="mt-1 text-slate-600">
                  Outstanding balance:{' '}
                  <strong>{money(balance.data.summary.balance, currency)}</strong>
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Amount" required>
                <input
                  type="number"
                  min={1}
                  step={100}
                  className="input"
                  {...form.register('amount', { required: true, valueAsNumber: true, min: 1 })}
                />
              </Field>
              <Field label="Payment date" required>
                <input
                  type="date"
                  className="input"
                  max={isoDate()}
                  {...form.register('paidAt', { required: true })}
                />
              </Field>
              <Field label="Method" required>
                <select className="input" {...form.register('method', { required: true })}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {titleCase(m)}
                    </option>
                  ))}
                </select>
              </Field>
              {selectedMethod === 'MOBILE_MONEY' && (
                <Field label="Provider" required>
                  <select className="input" {...form.register('provider', { required: true })}>
                    <option value="">Select…</option>
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {titleCase(p)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label="Reference"
                hint="M-Pesa transaction ID, bank slip or cheque number."
              >
                <input className="input" {...form.register('reference')} />
              </Field>
              <Field label="Paid by">
                <input className="input" placeholder="Parent's name" {...form.register('payerName')} />
              </Field>
            </div>

            <p className="text-xs text-slate-500">
              The payment settles the oldest unpaid invoices first. Anything above the outstanding
              balance is held as credit on the student's account.
            </p>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={record.isPending}>
                {record.isPending ? 'Saving…' : 'Record payment'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {receipt && (
        <Modal title="Payment receipt" onClose={() => setReceipt(null)}>
          <div className="print-receipt space-y-4 text-sm">
            <div className="border-b border-slate-200 pb-4 text-center">
              <h3 className="text-lg font-semibold text-slate-900">{receipt.school.name}</h3>
              {receipt.school.address && (
                <p className="text-xs text-slate-500">{receipt.school.address}</p>
              )}
              {receipt.school.phone && (
                <p className="text-xs text-slate-500">{receipt.school.phone}</p>
              )}
              <p className="mt-3 font-medium uppercase tracking-wide text-slate-700">
                Official fee receipt
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Row label="Receipt number" value={receipt.receipt.number} mono />
              <Row label="Date" value={dateTime(receipt.receipt.date)} />
              <Row label="Student" value={receipt.student.name} />
              <Row label="Admission number" value={receipt.student.admissionNumber} mono />
              <Row
                label="Class"
                value={`${receipt.student.className ?? '—'}${receipt.student.streamName ? ` ${receipt.student.streamName}` : ''}`}
              />
              <Row label="Method" value={titleCase(receipt.receipt.method)} />
              {receipt.receipt.reference && (
                <Row label="Reference" value={receipt.receipt.reference} mono />
              )}
              {receipt.receipt.payerName && <Row label="Paid by" value={receipt.receipt.payerName} />}
            </dl>

            {receipt.allocations.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Applied to
                </p>
                <ul className="space-y-1">
                  {receipt.allocations.map((a) => (
                    <li key={a.invoiceNumber} className="flex justify-between text-slate-700">
                      <span className="font-mono text-xs">{a.invoiceNumber}</span>
                      <span>{money(a.amount, receipt.school.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-slate-700">Amount paid</span>
                <span className="text-xl font-semibold text-slate-900">
                  {receipt.receipt.amountFormatted}
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between text-slate-600">
                <span>Balance after payment</span>
                <span>{money(receipt.outstandingAfter, receipt.school.currency)}</span>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2 print:hidden">
            <button type="button" className="btn-secondary" onClick={() => setReceipt(null)}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </Modal>
      )}

      {reversing && (
        <Modal title={`Reverse receipt ${reversing.receiptNumber}`} onClose={() => setReversing(null)}>
          {reverse.error != null && (
            <div className="mb-4">
              <ErrorNote error={reverse.error} />
            </div>
          )}
          <p className="mb-4 text-sm text-slate-600">
            Reversing restores the balance on the student's invoices and posts a contra entry to the
            ledger. The original receipt is kept for the audit trail.
          </p>
          <Field label="Reason" required>
            <textarea
              className="input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Cheque bounced, duplicate entry, refund issued…"
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setReversing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={reason.trim().length < 3 || reverse.isPending}
              onClick={() => reverse.mutate(reversing.id)}
            >
              {reverse.isPending ? 'Reversing…' : 'Reverse payment'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
