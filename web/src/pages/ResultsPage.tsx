import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { download, get, qs } from '../lib/api';
import { titleCase } from '../lib/format';
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
import type { ResultRow } from '../lib/types';

interface ResultSheet {
  exam: {
    id: string;
    name: string;
    examType: string;
    status: string;
    className: string | null;
    term: string | null;
    academicYear: string;
  };
  school: { name: string; rankingEnabled: boolean; motto: string | null };
  summary: { studentCount: number; classAverage: number; rankingEnabled: boolean };
  data: ResultRow[];
}

export function ResultsPage() {
  const { examId = '' } = useParams();
  const [reportCard, setReportCard] = useState<ResultRow | null>(null);

  const sheet = useQuery({
    queryKey: ['results', examId],
    queryFn: () => get<ResultSheet>(`/results/exam/${examId}`),
  });

  if (sheet.isLoading) return <Spinner label="Building result sheet…" />;
  if (sheet.error) return <ErrorNote error={sheet.error} />;
  if (!sheet.data) return null;

  const { exam, school, summary, data } = sheet.data;
  const subjects = data[0]?.subjects ?? [];

  return (
    <>
      <PageHeader
        title={exam.name}
        subtitle={`${titleCase(exam.examType)}${exam.className ? ` · ${exam.className}` : ''}${exam.term ? ` · ${exam.term}` : ''} · ${exam.academicYear}`}
        actions={
          <>
            <Link to="/exams" className="btn-secondary">
              Back to exams
            </Link>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                download(
                  `/reports/academic-performance${qs({ examId, format: 'csv' })}`,
                  'academic-performance.csv',
                )
              }
            >
              Export analysis
            </button>
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Students</p>
          <p className="mt-1 text-2xl font-semibold">{summary.studentCount}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Class average</p>
          <p className="mt-1 text-2xl font-semibold">{summary.classAverage}%</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
          <p className="mt-2">
            <Badge status={exam.status} />
          </p>
        </Card>
      </div>

      <Card padded={false}>
        {data.length === 0 ? (
          <EmptyState title="No students in this class" />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Admission No</th>
                  <th>Student</th>
                  {subjects.map((s) => (
                    <th key={s.code} className="text-center" title={s.subject}>
                      {s.code}
                    </th>
                  ))}
                  <th className="text-right">Total</th>
                  <th className="text-right">Average</th>
                  <th className="text-center">GPA</th>
                  {summary.rankingEnabled && <th className="text-center">Position</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.studentId}>
                    <td className="font-mono text-xs">{row.admissionNumber}</td>
                    <td className="whitespace-nowrap font-medium text-slate-900">{row.name}</td>
                    {row.subjects.map((s) => (
                      <td key={s.code} className="text-center">
                        {s.isAbsent ? (
                          <span className="text-xs text-slate-400">ABS</span>
                        ) : s.score === null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <>
                            {s.score}
                            {s.grade && (
                              <span className="ml-1 text-xs text-slate-400">{s.grade}</span>
                            )}
                          </>
                        )}
                      </td>
                    ))}
                    <td className="text-right">
                      {row.totalScore}/{row.totalMax}
                    </td>
                    <td className="text-right font-medium">{row.average}%</td>
                    <td className="text-center">{row.gpa ?? '—'}</td>
                    {summary.rankingEnabled && (
                      <td className="text-center font-semibold">{row.position ?? '—'}</td>
                    )}
                    <td className="text-right">
                      <button
                        type="button"
                        className="text-sm text-brand-700 hover:underline"
                        onClick={() => setReportCard(row)}
                      >
                        Report card
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {reportCard && (
        <Modal title="Report card" onClose={() => setReportCard(null)} wide>
          <div className="space-y-5 text-sm">
            <div className="border-b border-slate-200 pb-4 text-center">
              <h3 className="text-lg font-semibold text-slate-900">{school.name}</h3>
              {school.motto && <p className="text-xs italic text-slate-500">{school.motto}</p>}
              <p className="mt-3 font-medium uppercase tracking-wide text-slate-700">{exam.name}</p>
              <p className="text-xs text-slate-500">
                {exam.term ? `${exam.term} · ` : ''}
                {exam.academicYear}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Info label="Student" value={reportCard.name} />
              <Info label="Admission No" value={reportCard.admissionNumber} />
              <Info
                label="Class"
                value={`${reportCard.className ?? '—'}${reportCard.streamName ? ` ${reportCard.streamName}` : ''}`}
              />
              {summary.rankingEnabled && (
                <Info
                  label="Position"
                  value={`${reportCard.position ?? '—'} of ${summary.studentCount}`}
                />
              )}
            </div>

            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th className="text-right">Score</th>
                    <th className="text-center">Grade</th>
                    <th className="text-center">Points</th>
                    <th>Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {reportCard.subjects.map((s) => (
                    <tr key={s.code}>
                      <td>{s.subject}</td>
                      <td className="text-right">
                        {s.isAbsent ? 'Absent' : s.score === null ? '—' : `${s.score} / ${s.maxScore}`}
                      </td>
                      <td className="text-center font-medium">{s.grade ?? '—'}</td>
                      <td className="text-center">{s.points ?? '—'}</td>
                      <td className="text-xs text-slate-500">
                        {(s as { remark?: string | null }).remark ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div className="grid grid-cols-2 gap-4 border-t border-slate-200 pt-4 sm:grid-cols-4">
              <Info label="Total" value={`${reportCard.totalScore} / ${reportCard.totalMax}`} />
              <Info label="Average" value={`${reportCard.average}%`} />
              <Info label="GPA" value={String(reportCard.gpa ?? '—')} />
              <Info label="Class average" value={`${summary.classAverage}%`} />
            </div>

            <div className="grid gap-6 border-t border-slate-200 pt-6 sm:grid-cols-2">
              <div>
                <p className="border-b border-dashed border-slate-300 pb-6" />
                <p className="mt-1 text-xs text-slate-500">Class teacher</p>
              </div>
              <div>
                <p className="border-b border-dashed border-slate-300 pb-6" />
                <p className="mt-1 text-xs text-slate-500">Head teacher</p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2 print:hidden">
            <button type="button" className="btn-secondary" onClick={() => setReportCard(null)}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 font-medium text-slate-800">{value}</p>
    </div>
  );
}
