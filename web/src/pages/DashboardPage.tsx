import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { compactMoney, date, dateTime, money, titleCase } from '../lib/format';
import { Card, EmptyState, ErrorNote, PageHeader, Spinner, StatTile, TableWrap } from '../components/ui';
import type { DashboardData } from '../lib/types';

interface EnrollmentBreakdown {
  byClass: Array<{ id: string; name: string; students: number }>;
  byGender: Record<string, number>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const currency = user?.school?.currency ?? 'TZS';

  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardData>('/dashboard'),
  });

  const enrollment = useQuery({
    queryKey: ['dashboard', 'enrollment'],
    queryFn: () => get<EnrollmentBreakdown>('/dashboard/enrollment-by-class'),
  });

  if (dashboard.isLoading) return <Spinner label="Loading dashboard…" />;
  if (dashboard.error) return <ErrorNote error={dashboard.error} />;
  if (!dashboard.data) return null;

  const { widgets, upcomingExams, recentPayments, announcements } = dashboard.data;
  const attendance = widgets.attendanceToday;
  const maxClass = Math.max(1, ...(enrollment.data?.byClass.map((c) => c.students) ?? [1]));

  return (
    <>
      <PageHeader
        title={`Good day, ${user?.firstName ?? ''}`}
        subtitle={`${user?.school?.name ?? ''} · ${date(dashboard.data.date)}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total students"
          value={widgets.totalStudents.toLocaleString()}
          hint={`${widgets.newAdmissionsThisMonth} admitted this month`}
        />
        <StatTile
          label="Teachers"
          value={widgets.totalTeachers}
          hint={`${widgets.totalStaff} staff in total`}
          tone="slate"
        />
        <StatTile
          label="Collected this month"
          value={compactMoney(widgets.feeCollection.thisMonth, currency)}
          hint={`${widgets.feeCollection.paymentCount} payments`}
          tone="emerald"
        />
        <StatTile
          label="Outstanding fees"
          value={compactMoney(widgets.outstandingFees.total, currency)}
          hint={`${widgets.outstandingFees.invoiceCount} unpaid invoices`}
          tone="red"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Attendance today">
          {attendance.marked === 0 ? (
            <EmptyState
              title="No register taken yet"
              hint="Class teachers have not submitted attendance for today."
            />
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-slate-900">
                  {attendance.rate ?? 0}%
                </span>
                <span className="text-sm text-slate-500">present</span>
              </div>
              <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${attendance.rate ?? 0}%` }}
                />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-slate-500">Present</dt>
                  <dd className="font-medium text-emerald-700">{attendance.present}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Absent</dt>
                  <dd className="font-medium text-red-700">{attendance.absent}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Late</dt>
                  <dd className="font-medium text-amber-700">{attendance.late}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Not marked</dt>
                  <dd className="font-medium text-slate-700">{attendance.notMarked}</dd>
                </div>
              </dl>
            </>
          )}
          <Link to="/attendance" className="mt-5 inline-block text-sm text-brand-700 hover:underline">
            Open the register →
          </Link>
        </Card>

        <Card title="Enrolment by class" className="lg:col-span-2">
          {enrollment.isLoading ? (
            <Spinner />
          ) : (
            <ul className="space-y-3">
              {enrollment.data?.byClass.map((row) => (
                <li key={row.id} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-sm text-slate-600">{row.name}</span>
                  <div className="h-6 flex-1 overflow-hidden rounded bg-slate-100">
                    <div
                      className="flex h-full items-center justify-end rounded bg-brand-500 px-2 text-xs font-medium text-white"
                      style={{ width: `${Math.max(6, (row.students / maxClass) * 100)}%` }}
                    >
                      {row.students}
                    </div>
                  </div>
                </li>
              ))}
              {enrollment.data?.byClass.length === 0 && (
                <EmptyState title="No classes configured" hint="Add classes under Academics." />
              )}
            </ul>
          )}
          {enrollment.data && (
            <p className="mt-4 text-xs text-slate-500">
              Boys: {enrollment.data.byGender.MALE ?? 0} · Girls: {enrollment.data.byGender.FEMALE ?? 0}
            </p>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Recent payments" padded={false}>
          {recentPayments.length === 0 ? (
            <EmptyState title="No payments recorded yet" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Student</th>
                    <th>Method</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPayments.map((p) => (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.receiptNumber}</td>
                      <td>
                        {p.student.firstName} {p.student.lastName}
                        <span className="block text-xs text-slate-400">
                          {p.student.admissionNumber}
                        </span>
                      </td>
                      <td className="text-xs">{titleCase(p.method)}</td>
                      <td className="text-right font-medium">{money(p.amount, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Upcoming examinations">
            {upcomingExams.length === 0 ? (
              <EmptyState title="Nothing scheduled" hint="No exams are set for the coming weeks." />
            ) : (
              <ul className="space-y-3">
                {upcomingExams.map((exam) => (
                  <li key={exam.id} className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{exam.name}</p>
                      <p className="text-xs text-slate-500">
                        {titleCase(exam.examType)}
                        {exam.schoolClass ? ` · ${exam.schoolClass.name}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">{date(exam.startDate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Announcements">
            {announcements.length === 0 ? (
              <EmptyState title="No announcements" />
            ) : (
              <ul className="space-y-4">
                {announcements.map((a) => (
                  <li key={a.id}>
                    <p className="text-sm font-medium text-slate-800">
                      {a.isPinned && <span className="mr-1">📌</span>}
                      {a.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{a.body}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{dateTime(a.publishedAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
