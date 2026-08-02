import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, fullName, money } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  Spinner,
  StatTile,
  TableWrap,
} from '../components/ui';
import type { PortalChild } from '../lib/types';

interface Overview {
  student: PortalChild;
  attendance: { totalDays: number; rate: number | null } & Record<string, number>;
  fees: { totalBilled: string; totalPaid: string; balance: string };
  upcomingHomework: Array<{
    id: string;
    title: string;
    dueDate: string;
    subject: { name: string };
  }>;
}

const TABS = ['Overview', 'Attendance', 'Results', 'Fees', 'Homework', 'Timetable'] as const;
type Tab = (typeof TABS)[number];

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Modules 19 & 20 — the parent and student portals. */
export function PortalPage() {
  const { user, hasRole } = useAuth();
  const currency = user?.school?.currency ?? 'TZS';

  const [studentId, setStudentId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('Overview');

  const children = useQuery({
    queryKey: ['portal', 'children'],
    queryFn: () => get<{ data: PortalChild[] }>('/portal/children'),
  });

  useEffect(() => {
    if (!studentId && children.data?.data[0]) setStudentId(children.data.data[0].id);
  }, [children.data, studentId]);

  const overview = useQuery({
    queryKey: ['portal', studentId, 'overview'],
    queryFn: () => get<Overview>(`/portal/students/${studentId}/overview`),
    enabled: Boolean(studentId),
  });

  const attendance = useQuery({
    queryKey: ['portal', studentId, 'attendance'],
    queryFn: () =>
      get<{ data: Array<{ id: string; date: string; status: string; note: string | null }> }>(
        `/portal/students/${studentId}/attendance`,
      ),
    enabled: Boolean(studentId) && tab === 'Attendance',
  });

  const results = useQuery({
    queryKey: ['portal', studentId, 'results'],
    queryFn: () =>
      get<{
        exams: Array<{
          exam: { id: string; name: string; term: { name: string } | null };
          subjects: Array<{ subject: string; score: number | null; maxScore: number; grade: string | null }>;
          average: number;
          gpa: number | null;
        }>;
      }>(`/portal/students/${studentId}/results`),
    enabled: Boolean(studentId) && tab === 'Results',
  });

  const fees = useQuery({
    queryKey: ['portal', studentId, 'fees'],
    queryFn: () =>
      get<{
        summary: { totalBilled: string; totalPaid: string; balance: string };
        invoices: Array<{
          id: string;
          invoiceNumber: string;
          dueDate: string;
          total: string;
          amountPaid: string;
          balance: string;
          status: string;
        }>;
        payments: Array<{ id: string; receiptNumber: string; paidAt: string; amount: string; method: string }>;
      }>(`/portal/students/${studentId}/fees`),
    enabled: Boolean(studentId) && tab === 'Fees',
  });

  const homework = useQuery({
    queryKey: ['portal', studentId, 'homework'],
    queryFn: () =>
      get<{
        data: Array<{
          id: string;
          title: string;
          instructions: string | null;
          dueDate: string;
          maxScore: number;
          subject: { name: string };
          teacher: { firstName: string; lastName: string } | null;
          submissions: Array<{ id: string; submittedAt: string; score: number | null }>;
        }>;
      }>(`/portal/students/${studentId}/homework`),
    enabled: Boolean(studentId) && tab === 'Homework',
  });

  const timetable = useQuery({
    queryKey: ['portal', studentId, 'timetable'],
    queryFn: () =>
      get<{
        data: Array<{
          id: string;
          dayOfWeek: number;
          startTime: string;
          endTime: string;
          room: string | null;
          subject: { name: string; code: string };
          teacher: { firstName: string; lastName: string } | null;
        }>;
      }>(`/portal/students/${studentId}/timetable`),
    enabled: Boolean(studentId) && tab === 'Timetable',
  });

  if (children.isLoading) return <Spinner />;
  if (children.error) return <ErrorNote error={children.error} />;

  const list = children.data?.data ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No student records linked to your account"
          hint="Contact the school office so they can link your children to your portal login."
        />
      </Card>
    );
  }

  const selected = list.find((c) => c.id === studentId);
  const enrollment = selected?.enrollments[0];

  return (
    <>
      <PageHeader
        title={hasRole('PARENT') ? 'My children' : 'My school'}
        subtitle={user?.school?.name ?? ''}
      />

      {list.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {list.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => setStudentId(child.id)}
              className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                child.id === studentId
                  ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {child.firstName} {child.lastName}
              <span className="ml-2 text-xs text-slate-400">
                {child.enrollments[0]?.schoolClass.name}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-700">
              {selected.firstName[0]}
              {selected.lastName[0]}
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-900">{fullName(selected)}</p>
              <p className="text-sm text-slate-500">
                {selected.admissionNumber}
                {enrollment
                  ? ` · ${enrollment.schoolClass.name}${enrollment.stream ? ` ${enrollment.stream.name}` : ''} · ${enrollment.academicYear.name}`
                  : ''}
              </p>
            </div>
            <div className="ml-auto">
              <Badge status={selected.status} />
            </div>
          </div>
        </Card>
      )}

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' &&
        (overview.isLoading ? (
          <Spinner />
        ) : overview.error ? (
          <ErrorNote error={overview.error} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile
                label="Attendance"
                value={overview.data?.attendance.rate != null ? `${overview.data.attendance.rate}%` : '—'}
                hint={`${overview.data?.attendance.totalDays ?? 0} days recorded`}
                tone="emerald"
              />
              <StatTile
                label="Fee balance"
                value={money(overview.data?.fees.balance, currency)}
                hint={`Billed ${money(overview.data?.fees.totalBilled, currency)}`}
                tone={Number(overview.data?.fees.balance ?? 0) > 0 ? 'red' : 'emerald'}
              />
              <StatTile
                label="Homework due"
                value={overview.data?.upcomingHomework.length ?? 0}
                hint="In the coming days"
                tone="amber"
              />
            </div>

            <Card title="Upcoming homework" className="mt-6">
              {overview.data?.upcomingHomework.length === 0 ? (
                <EmptyState title="Nothing due" hint="No homework is outstanding right now." />
              ) : (
                <ul className="space-y-3">
                  {overview.data?.upcomingHomework.map((hw) => (
                    <li key={hw.id} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{hw.title}</p>
                        <p className="text-xs text-slate-500">{hw.subject.name}</p>
                      </div>
                      <span className="shrink-0 text-xs text-slate-500">Due {date(hw.dueDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        ))}

      {tab === 'Attendance' && (
        <Card padded={false}>
          {attendance.isLoading ? (
            <Spinner />
          ) : attendance.data?.data.length === 0 ? (
            <EmptyState title="No attendance recorded yet" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.data?.data.map((row) => (
                    <tr key={row.id}>
                      <td>{date(row.date)}</td>
                      <td>
                        <Badge status={row.status} />
                      </td>
                      <td className="text-slate-500">{row.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {tab === 'Results' && (
        <div className="space-y-6">
          {results.isLoading ? (
            <Spinner />
          ) : results.data?.exams.length === 0 ? (
            <Card>
              <EmptyState
                title="No results published yet"
                hint="Results appear here once the school publishes them."
              />
            </Card>
          ) : (
            results.data?.exams.map((entry) => (
              <Card key={entry.exam.id} title={entry.exam.name} padded={false}>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th className="text-right">Score</th>
                        <th className="text-center">Grade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.subjects.map((s) => (
                        <tr key={s.subject}>
                          <td>{s.subject}</td>
                          <td className="text-right">
                            {s.score === null ? 'Absent' : `${s.score} / ${s.maxScore}`}
                          </td>
                          <td className="text-center font-medium">{s.grade ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <div className="flex gap-6 border-t border-slate-200 px-5 py-3 text-sm">
                  <span>
                    Average: <strong>{entry.average}%</strong>
                  </span>
                  {entry.gpa !== null && (
                    <span>
                      GPA: <strong>{entry.gpa}</strong>
                    </span>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {tab === 'Fees' && (
        <div className="space-y-6">
          {fees.isLoading ? (
            <Spinner />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatTile label="Billed" value={money(fees.data?.summary.totalBilled, currency)} tone="slate" />
                <StatTile label="Paid" value={money(fees.data?.summary.totalPaid, currency)} tone="emerald" />
                <StatTile
                  label="Balance"
                  value={money(fees.data?.summary.balance, currency)}
                  tone={Number(fees.data?.summary.balance ?? 0) > 0 ? 'red' : 'emerald'}
                />
              </div>

              <Card title="Invoices" padded={false}>
                {fees.data?.invoices.length === 0 ? (
                  <EmptyState title="No invoices issued" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Due</th>
                          <th className="text-right">Total</th>
                          <th className="text-right">Balance</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fees.data?.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td className="font-mono text-xs">{inv.invoiceNumber}</td>
                            <td>{date(inv.dueDate)}</td>
                            <td className="text-right">{money(inv.total, currency)}</td>
                            <td className="text-right font-medium">{money(inv.balance, currency)}</td>
                            <td>
                              <Badge status={inv.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>

              <Card title="Payments received" padded={false}>
                {fees.data?.payments.length === 0 ? (
                  <EmptyState title="No payments recorded" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Receipt</th>
                          <th>Date</th>
                          <th>Method</th>
                          <th className="text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fees.data?.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="font-mono text-xs">{p.receiptNumber}</td>
                            <td>{date(p.paidAt)}</td>
                            <td>{p.method}</td>
                            <td className="text-right">{money(p.amount, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {tab === 'Homework' && (
        <div className="space-y-4">
          {homework.isLoading ? (
            <Spinner />
          ) : homework.data?.data.length === 0 ? (
            <Card>
              <EmptyState title="No homework set" />
            </Card>
          ) : (
            homework.data?.data.map((hw) => {
              const submitted = hw.submissions[0];
              const overdue = !submitted && new Date(hw.dueDate) < new Date();
              return (
                <Card key={hw.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{hw.title}</p>
                      <p className="text-sm text-slate-500">
                        {hw.subject.name}
                        {hw.teacher ? ` · ${hw.teacher.firstName} ${hw.teacher.lastName}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm ${overdue ? 'font-medium text-red-700' : 'text-slate-600'}`}>
                        Due {date(hw.dueDate)}
                      </p>
                      {submitted ? (
                        <span className="badge mt-1 bg-emerald-100 text-emerald-800">
                          Submitted{submitted.score != null ? ` · ${submitted.score}/${hw.maxScore}` : ''}
                        </span>
                      ) : (
                        <span className="badge mt-1 bg-amber-100 text-amber-800">Not submitted</span>
                      )}
                    </div>
                  </div>
                  {hw.instructions && (
                    <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                      {hw.instructions}
                    </p>
                  )}
                </Card>
              );
            })
          )}
        </div>
      )}

      {tab === 'Timetable' && (
        <div className="space-y-4">
          {timetable.isLoading ? (
            <Spinner />
          ) : timetable.data?.data.length === 0 ? (
            <Card>
              <EmptyState title="No timetable published" />
            </Card>
          ) : (
            [1, 2, 3, 4, 5].map((day) => {
              const slots = timetable.data?.data.filter((s) => s.dayOfWeek === day) ?? [];
              if (slots.length === 0) return null;
              return (
                <Card key={day} title={DAYS[day]} padded={false}>
                  <TableWrap>
                    <table className="table">
                      <tbody>
                        {slots.map((slot) => (
                          <tr key={slot.id}>
                            <td className="w-32 font-mono text-xs">
                              {slot.startTime}–{slot.endTime}
                            </td>
                            <td className="font-medium">{slot.subject.name}</td>
                            <td className="text-slate-500">
                              {slot.teacher
                                ? `${slot.teacher.firstName} ${slot.teacher.lastName}`
                                : '—'}
                            </td>
                            <td className="text-right text-xs text-slate-400">{slot.room ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </Card>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
