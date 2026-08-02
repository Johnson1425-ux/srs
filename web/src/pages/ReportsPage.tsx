import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { download, get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isoDate } from '../lib/format';
import { Card, ErrorNote, Field, PageHeader } from '../components/ui';
import type { Permission, SchoolClass } from '../lib/types';

interface ReportSpec {
  key: string;
  title: string;
  description: string;
  path: string;
  permissions: Permission[];
  needs: Array<'dateRange' | 'class' | 'period'>;
}

const REPORTS: ReportSpec[] = [
  {
    key: 'students',
    title: 'Student register',
    description: 'Full student list with class, guardian and contact details.',
    path: '/reports/students',
    permissions: ['students:read'],
    needs: ['class'],
  },
  {
    key: 'admissions',
    title: 'Admissions',
    description: 'Students admitted within a date range.',
    path: '/reports/admissions',
    permissions: ['students:read'],
    needs: ['dateRange'],
  },
  {
    key: 'attendance',
    title: 'Attendance summary',
    description: 'Per-student attendance counts and rate for a period.',
    path: '/reports/attendance',
    permissions: ['attendance:read'],
    needs: ['dateRange', 'class'],
  },
  {
    key: 'fee-collection',
    title: 'Fee collection',
    description: 'Every confirmed payment received in a period.',
    path: '/reports/fee-collection',
    permissions: ['fees:read'],
    needs: ['dateRange'],
  },
  {
    key: 'outstanding-fees',
    title: 'Outstanding fees',
    description: 'Unpaid invoice balances with fee-payer contacts.',
    path: '/reports/outstanding-fees',
    permissions: ['fees:read'],
    needs: ['class'],
  },
  {
    key: 'teacher-performance',
    title: 'Teacher workload',
    description: 'Lessons taught, registers taken and assignments set.',
    path: '/reports/teacher-performance',
    permissions: ['staff:read'],
    needs: [],
  },
  {
    key: 'library',
    title: 'Library catalogue',
    description: 'Book stock, availability and borrowing frequency.',
    path: '/reports/library',
    permissions: ['library:read'],
    needs: [],
  },
  {
    key: 'inventory',
    title: 'Inventory',
    description: 'Stock levels, reorder points and valuation.',
    path: '/reports/inventory',
    permissions: ['inventory:read'],
    needs: [],
  },
  {
    key: 'payroll',
    title: 'Payroll',
    description: 'Payslip breakdown for a payroll period.',
    path: '/reports/payroll',
    permissions: ['payroll:read'],
    needs: ['period'],
  },
];

export function ReportsPage() {
  const { can } = useAuth();
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(isoDate());
  const [classId, setClassId] = useState('');
  const [period, setPeriod] = useState(isoDate().slice(0, 7));
  const [error, setError] = useState<unknown>(null);

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
  });

  const available = REPORTS.filter((r) => can(...r.permissions));

  const run = async (report: ReportSpec, format: 'csv') => {
    setError(null);
    const params: Record<string, string> = { format };
    if (report.needs.includes('dateRange')) {
      params.from = from;
      params.to = to;
    }
    if (report.needs.includes('class') && classId) params.classId = classId;
    if (report.needs.includes('period')) params.period = period;

    try {
      await download(`${report.path}${qs(params)}`, `${report.key}.csv`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Operational and financial reports, exportable to CSV or Excel"
      />

      {error != null && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}

      <Card title="Report parameters" className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Class">
            <select className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">All classes</option>
              {classes.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payroll period" hint="YYYY-MM">
            <input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Each report only uses the parameters it needs — the rest are ignored.
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {available.map((report) => (
          <Card key={report.key}>
            <h2 className="font-medium text-slate-900">{report.title}</h2>
            <p className="mt-1 min-h-[40px] text-sm text-slate-500">{report.description}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => void run(report, 'csv')}>
                Download CSV
              </button>
            </div>
            {report.needs.length > 0 && (
              <p className="mt-3 text-xs text-slate-400">
                Uses:{' '}
                {report.needs
                  .map((n) =>
                    n === 'dateRange' ? 'date range' : n === 'class' ? 'class filter' : 'payroll period',
                  )
                  .join(', ')}
              </p>
            )}
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        CSV files open directly in Excel and Google Sheets. Report cards, receipts and result sheets
        print to PDF from their own screens using your browser's print dialog.
      </p>
    </>
  );
}
