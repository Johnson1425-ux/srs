import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { del, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, fullName, money, titleCase } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { Guardian, Invoice, Paginated, Payment, Student } from '../lib/types';

interface BalanceResponse {
  summary: { totalBilled: string; totalPaid: string; balance: string; invoiceCount: number };
  invoices: Invoice[];
  payments: Payment[];
}

interface AttendanceResponse {
  data: Array<{ id: string; date: string; status: string; note: string | null }>;
  summary: { totalDays: number; attendanceRate: number } & Record<string, number>;
}

const TABS = ['Profile', 'Attendance', 'Fees', 'Results'] as const;
type Tab = (typeof TABS)[number];

export function StudentDetailPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [tab, setTab] = useState<Tab>('Profile');
  const [statusModal, setStatusModal] = useState(false);
  const [newStatus, setNewStatus] = useState('SUSPENDED');
  const [reason, setReason] = useState('');

  const [linkModal, setLinkModal] = useState(false);
  const [parentSearch, setParentSearch] = useState('');
  const [chosenGuardian, setChosenGuardian] = useState('');
  const [asPrimary, setAsPrimary] = useState(false);
  const [asFeePayer, setAsFeePayer] = useState(false);

  const student = useQuery({
    queryKey: ['student', id],
    queryFn: () => get<Student>(`/students/${id}`),
  });

  const attendance = useQuery({
    queryKey: ['student', id, 'attendance'],
    queryFn: () => get<AttendanceResponse>(`/attendance/student/${id}`),
    enabled: tab === 'Attendance' && can('attendance:read'),
  });

  const fees = useQuery({
    queryKey: ['student', id, 'fees'],
    queryFn: () => get<BalanceResponse>(`/fees/students/${id}/balance`),
    enabled: tab === 'Fees' && can('fees:read'),
  });

  const results = useQuery({
    queryKey: ['student', id, 'results'],
    queryFn: () =>
      get<{
        exams: Array<{
          exam: { id: string; name: string; examType: string };
          subjects: Array<{ subject: string; score: number | null; maxScore: number; grade: string | null }>;
          average: number;
          gpa: number | null;
        }>;
      }>(`/results/transcript/${id}`),
    enabled: tab === 'Results' && can('exams:read'),
  });

  const parentResults = useQuery({
    queryKey: ['parents', 'search', parentSearch],
    queryFn: () =>
      get<Paginated<Guardian>>(`/parents${qs({ search: parentSearch, pageSize: 10 })}`),
    enabled: linkModal && parentSearch.trim().length >= 2,
  });

  const closeLinkModal = () => {
    setLinkModal(false);
    setParentSearch('');
    setChosenGuardian('');
    setAsPrimary(false);
    setAsFeePayer(false);
  };

  const linkParent = useMutation({
    mutationFn: () =>
      post(`/students/${id}/guardians`, {
        guardianId: chosenGuardian,
        isPrimary: asPrimary,
        isFeePayer: asFeePayer,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student', id] });
      void queryClient.invalidateQueries({ queryKey: ['parents'] });
      closeLinkModal();
    },
  });

  const unlinkParent = useMutation({
    mutationFn: (guardianId: string) => del(`/students/${id}/guardians/${guardianId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student', id] });
      void queryClient.invalidateQueries({ queryKey: ['parents'] });
    },
  });

  const changeStatus = useMutation({
    mutationFn: () => post(`/students/${id}/status`, { status: newStatus, reason: reason || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student', id] });
      void queryClient.invalidateQueries({ queryKey: ['students'] });
      setStatusModal(false);
      setReason('');
    },
  });

  if (student.isLoading) return <Spinner />;
  if (student.error) return <ErrorNote error={student.error} />;
  if (!student.data) return null;

  const s = student.data;
  const enrollment = s.enrollments[0];

  return (
    <>
      <PageHeader
        title={fullName(s)}
        subtitle={`${s.admissionNumber}${enrollment ? ` · ${enrollment.schoolClass.name}${enrollment.stream ? ` ${enrollment.stream.name}` : ''}` : ''}`}
        actions={
          <>
            <Link to="/students" className="btn-secondary">
              Back to list
            </Link>
            {can('students:manage') && (
              <button type="button" className="btn-secondary" onClick={() => setStatusModal(true)}>
                Change status
              </button>
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge status={s.status} />
        <span className="text-sm text-slate-500">Admitted {date(s.admissionDate)}</span>
      </div>

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

      {tab === 'Profile' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Student details">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Admission number" value={s.admissionNumber} />
              <Detail label="Gender" value={titleCase(s.gender)} />
              <Detail label="Date of birth" value={date(s.dateOfBirth)} />
              <Detail label="Class" value={enrollment?.schoolClass.name ?? '—'} />
              <Detail label="Stream" value={enrollment?.stream?.name ?? '—'} />
              <Detail label="Academic year" value={enrollment?.academicYear.name ?? '—'} />
              <Detail label="Address" value={s.address ?? '—'} />
              <Detail label="Previous school" value={s.previousSchool ?? '—'} />
              <Detail label="Emergency contact" value={s.emergencyContactName ?? '—'} />
              <Detail label="Emergency phone" value={s.emergencyContactPhone ?? '—'} />
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-slate-500">Medical conditions</dt>
                <dd className="mt-1 text-slate-800">{s.medicalConditions || 'None recorded'}</dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Parents and guardians"
            actions={
              can('students:manage', 'guardians:manage') && (
                <button
                  type="button"
                  className="btn-secondary px-3 py-1 text-xs"
                  onClick={() => setLinkModal(true)}
                >
                  Link a parent
                </button>
              )
            }
          >
            {unlinkParent.error != null && (
              <div className="mb-4">
                <ErrorNote error={unlinkParent.error} />
              </div>
            )}
            {s.guardianLinks.length === 0 ? (
              <EmptyState
                title="No guardian linked"
                hint="Use “Link a parent” to attach an existing parent record, or create one under Parents first."
              />
            ) : (
              <ul className="space-y-4">
                {s.guardianLinks.map((link) => (
                  <li key={link.id} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {link.guardian.firstName} {link.guardian.lastName}
                        </p>
                        <p className="text-sm text-slate-500">{link.guardian.relationship}</p>
                      </div>
                      <div className="flex gap-1">
                        {link.isPrimary && <span className="badge bg-brand-100 text-brand-800">Primary</span>}
                        {link.isFeePayer && (
                          <span className="badge bg-emerald-100 text-emerald-800">Fee payer</span>
                        )}
                      </div>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <Detail label="Phone" value={link.guardian.phone} />
                      <Detail label="Email" value={link.guardian.email ?? '—'} />
                      <Detail label="Occupation" value={link.guardian.occupation ?? '—'} />
                    </dl>
                    {can('students:manage', 'guardians:manage') && (
                      <div className="mt-3 border-t border-slate-100 pt-3 text-right">
                        <button
                          type="button"
                          className="text-sm text-red-700 hover:underline disabled:opacity-50"
                          disabled={unlinkParent.isPending}
                          onClick={() => unlinkParent.mutate(link.guardian.id)}
                        >
                          Unlink
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === 'Attendance' && (
        <Card title="Attendance history" padded={false}>
          {attendance.isLoading ? (
            <Spinner />
          ) : attendance.error ? (
            <div className="p-5">
              <ErrorNote error={attendance.error} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 border-b border-slate-200 p-5 sm:grid-cols-4">
                <Stat label="Attendance rate" value={`${attendance.data?.summary.attendanceRate ?? 0}%`} />
                <Stat label="Days recorded" value={attendance.data?.summary.totalDays ?? 0} />
                <Stat label="Absences" value={attendance.data?.summary.ABSENT ?? 0} />
                <Stat label="Late arrivals" value={attendance.data?.summary.LATE ?? 0} />
              </div>
              {attendance.data && attendance.data.data.length === 0 ? (
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
                      {attendance.data?.data.slice(0, 60).map((row) => (
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
            </>
          )}
        </Card>
      )}

      {tab === 'Fees' && (
        <div className="space-y-6">
          {fees.isLoading ? (
            <Spinner />
          ) : fees.error ? (
            <ErrorNote error={fees.error} />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <Stat label="Total billed" value={money(fees.data?.summary.totalBilled, currency)} />
                </Card>
                <Card>
                  <Stat label="Total paid" value={money(fees.data?.summary.totalPaid, currency)} />
                </Card>
                <Card>
                  <Stat label="Balance" value={money(fees.data?.summary.balance, currency)} />
                </Card>
              </div>

              <Card title="Invoices" padded={false}>
                {fees.data && fees.data.invoices.length === 0 ? (
                  <EmptyState title="No invoices issued" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Issued</th>
                          <th>Due</th>
                          <th className="text-right">Total</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fees.data?.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td className="font-mono text-xs">{inv.invoiceNumber}</td>
                            <td>{date(inv.issueDate)}</td>
                            <td>{date(inv.dueDate)}</td>
                            <td className="text-right">{money(inv.total, currency)}</td>
                            <td className="text-right">{money(inv.amountPaid, currency)}</td>
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

              <Card title="Payment history" padded={false}>
                {fees.data && fees.data.payments.length === 0 ? (
                  <EmptyState title="No payments recorded" />
                ) : (
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Receipt</th>
                          <th>Date</th>
                          <th>Method</th>
                          <th>Reference</th>
                          <th className="text-right">Amount</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fees.data?.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="font-mono text-xs">{p.receiptNumber}</td>
                            <td>{date(p.paidAt)}</td>
                            <td>{titleCase(p.method)}</td>
                            <td className="text-xs text-slate-500">{p.reference ?? '—'}</td>
                            <td className="text-right">{money(p.amount, currency)}</td>
                            <td>
                              <Badge status={p.status} />
                            </td>
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

      {tab === 'Results' && (
        <div className="space-y-6">
          {results.isLoading ? (
            <Spinner />
          ) : results.error ? (
            <ErrorNote error={results.error} />
          ) : results.data && results.data.exams.length === 0 ? (
            <Card>
              <EmptyState
                title="No published results"
                hint="Results appear here once an exam is published."
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
                      {entry.subjects.map((sub) => (
                        <tr key={sub.subject}>
                          <td>{sub.subject}</td>
                          <td className="text-right">
                            {sub.score === null ? '—' : `${sub.score}/${sub.maxScore}`}
                          </td>
                          <td className="text-center font-medium">{sub.grade ?? '—'}</td>
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

      {linkModal && (
        <Modal title="Link a parent to this student" onClose={closeLinkModal}>
          {linkParent.error != null && (
            <div className="mb-4">
              <ErrorNote error={linkParent.error} />
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="parent-search">
                Find an existing parent
              </label>
              <input
                id="parent-search"
                className="input"
                autoFocus
                placeholder="Name, phone or email"
                value={parentSearch}
                onChange={(e) => setParentSearch(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Not registered yet? Add them under Parents first, then link them here.
              </p>
            </div>

            {parentSearch.trim().length >= 2 && (
              <div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200">
                {parentResults.isLoading ? (
                  <Spinner label="Searching…" />
                ) : parentResults.data?.data.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No parents match that search.</p>
                ) : (
                  <ul>
                    {parentResults.data?.data.map((g) => (
                      <li key={g.id}>
                        <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm last:border-0 hover:bg-slate-50">
                          <input
                            type="radio"
                            name="guardian"
                            value={g.id}
                            checked={chosenGuardian === g.id}
                            onChange={() => setChosenGuardian(g.id)}
                          />
                          <span>
                            <span className="font-medium">
                              {g.firstName} {g.lastName}
                            </span>
                            <span className="block text-xs text-slate-400">
                              {g.relationship} · {g.phone}
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
                Primary contact
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={asFeePayer}
                  onChange={(e) => setAsFeePayer(e.target.checked)}
                />
                Responsible for fees
              </label>
              <p className="text-xs text-slate-500">
                A student has one primary contact and one fee payer — setting these moves them from
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
                disabled={!chosenGuardian || linkParent.isPending}
                onClick={() => linkParent.mutate()}
              >
                {linkParent.isPending ? 'Linking…' : 'Link parent'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {statusModal && (
        <Modal title="Change student status" onClose={() => setStatusModal(false)}>
          {changeStatus.error != null && (
            <div className="mb-4">
              <ErrorNote error={changeStatus.error} />
            </div>
          )}
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="new-status">
                New status
              </label>
              <select
                id="new-status"
                className="input"
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
              >
                <option value="ACTIVE">Active (reinstate)</option>
                <option value="SUSPENDED">Suspended</option>
                <option value="GRADUATED">Graduated</option>
                <option value="TRANSFERRED">Transferred out</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="status-reason">
                Reason
              </label>
              <textarea
                id="status-reason"
                className="input"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded on the audit trail"
              />
            </div>
            <p className="text-xs text-slate-500">
              Graduating, transferring or archiving a student ends their active enrolment and
              disables their portal login.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setStatusModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={changeStatus.isPending}
                onClick={() => changeStatus.mutate()}
              >
                {changeStatus.isPending ? 'Saving…' : 'Update status'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}
