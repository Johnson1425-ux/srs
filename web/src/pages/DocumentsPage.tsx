import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  Pagination,
  Spinner,
  StatTile,
  TableWrap,
} from '../components/ui';
import {
  DOC_TYPES,
  type DocType,
  type FileLink,
  type Paginated,
  type SchoolClass,
  type SchoolDocument,
  type StorageUsageResponse,
} from '../lib/types';

const LABELS: Record<DocType, string> = {
  BIRTH_CERTIFICATE: 'Birth certificate',
  LEAVING_CERTIFICATE: 'Leaving certificate',
  MEDICAL_REPORT: 'Medical report',
  CONTRACT: 'Contract',
  ID_COPY: 'ID copy',
  RESULT_SLIP: 'Result slip',
  OTHER: 'Other',
};

function fileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MissingStudent {
  id: string;
  admissionNumber: string;
  firstName: string;
  lastName: string;
  status: string;
  enrollments: Array<{
    schoolClass: { name: string } | null;
    stream: { name: string } | null;
  }>;
}

const TABS = ['All documents', 'Missing'] as const;
type Tab = (typeof TABS)[number];

/**
 * The school's whole document register.
 *
 * Uploading happens where the record is — on a student or a staff member —
 * because a document only means anything filed against someone. This page is
 * for the two questions that cannot be asked from there: what is on file
 * across the school, and who is still missing something.
 */
export function DocumentsPage() {
  const { can } = useAuth();

  const [tab, setTab] = useState<Tab>('All documents');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [docType, setDocType] = useState<DocType | ''>('');
  const [subject, setSubject] = useState<'' | 'student' | 'staff'>('');

  const [missingType, setMissingType] = useState<DocType>('BIRTH_CERTIFICATE');
  const [missingClass, setMissingClass] = useState('');
  const [missingPage, setMissingPage] = useState(1);

  const usage = useQuery({
    queryKey: ['documents', 'usage'],
    queryFn: () => get<StorageUsageResponse>('/documents/usage'),
    retry: false,
  });

  const documents = useQuery({
    queryKey: ['documents', 'all', page, search, docType, subject],
    queryFn: () =>
      get<Paginated<SchoolDocument>>(
        `/documents${qs({ page, pageSize: 25, search, docType, subject })}`,
      ),
    enabled: tab === 'All documents',
  });

  const classes = useQuery({
    queryKey: ['academics', 'classes'],
    // This endpoint wraps its array in `{ data }`, as the other pages reading
    // it also assume.
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
    enabled: tab === 'Missing' && can('academics:read'),
  });

  const missing = useQuery({
    queryKey: ['documents', 'missing', missingType, missingClass, missingPage],
    queryFn: () =>
      get<Paginated<MissingStudent>>(
        `/documents/missing${qs({
          docType: missingType,
          classId: missingClass,
          page: missingPage,
          pageSize: 50,
        })}`,
      ),
    enabled: tab === 'Missing',
  });

  /** The signed URL is fetched on click, because it expires in minutes. */
  const open = useMutation({
    mutationFn: async (documentId: string) => {
      const link = await get<FileLink>(`/documents/${documentId}/file`);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
  });

  const rows = documents.data?.data ?? [];
  const missingRows = missing.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Everything on file across the school, and what is still outstanding."
      />

      {usage.data && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Files stored" value={usage.data.files} />
          <StatTile label="Documents filed" value={usage.data.documents} />
          <StatTile label="Storage used" value={`${usage.data.usedMb} MB`} />
          <StatTile
            label="Of quota"
            value={`${usage.data.percentUsed}%`}
            hint={`${usage.data.quotaMb} MB allowed`}
          />
        </div>
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

      {open.error != null && (
        <div className="mb-4">
          <ErrorNote error={open.error} />
        </div>
      )}

      {tab === 'All documents' && (
        <Card padded={false}>
          <div className="grid gap-3 border-b border-slate-200 p-5 sm:grid-cols-3">
            <Field label="Search">
              <input
                className="input"
                value={search}
                placeholder="Title, filename, name or number"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field label="Type">
              <select
                className="input"
                value={docType}
                onChange={(e) => {
                  setDocType(e.target.value as DocType | '');
                  setPage(1);
                }}
              >
                <option value="">All types</option>
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filed against">
              <select
                className="input"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value as '' | 'student' | 'staff');
                  setPage(1);
                }}
              >
                <option value="">Anyone</option>
                <option value="student">Students</option>
                <option value="staff">Staff</option>
              </select>
            </Field>
          </div>

          {documents.isLoading ? (
            <Spinner />
          ) : documents.error ? (
            <div className="p-5">
              <ErrorNote error={documents.error} />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Nothing on file"
                hint="Documents are uploaded from a student or staff record. Open one and use its Documents tab."
              />
            </div>
          ) : (
            <>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Filed against</th>
                      <th>Size</th>
                      <th>Filed</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((doc) => (
                      <tr key={doc.id}>
                        <td className="font-medium text-slate-900">
                          {doc.title}
                          {doc.storedFile && (
                            <span className="block text-xs font-normal text-slate-500">
                              {doc.storedFile.filename}
                            </span>
                          )}
                        </td>
                        <td>{LABELS[doc.docType] ?? doc.docType}</td>
                        <td>
                          {doc.student ? (
                            <>
                              {doc.student.firstName} {doc.student.lastName}
                              <span className="block text-xs text-slate-500">
                                {doc.student.admissionNumber}
                              </span>
                            </>
                          ) : doc.staff ? (
                            <>
                              {doc.staff.firstName} {doc.staff.lastName}
                              <span className="block text-xs text-slate-500">
                                {doc.staff.staffNumber}
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{fileSize(doc.storedFile?.sizeBytes ?? doc.sizeBytes)}</td>
                        <td>{date(doc.createdAt)}</td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="text-sm text-brand-700 hover:underline disabled:opacity-50"
                            disabled={open.isPending}
                            onClick={() => open.mutate(doc.id)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {documents.data && (
                <Pagination
                  page={documents.data.meta.page}
                  totalPages={documents.data.meta.totalPages}
                  total={documents.data.meta.total}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </Card>
      )}

      {tab === 'Missing' && (
        <Card padded={false}>
          <div className="grid gap-3 border-b border-slate-200 p-5 sm:grid-cols-2">
            <Field label="Document type" required>
              <select
                className="input"
                value={missingType}
                onChange={(e) => {
                  setMissingType(e.target.value as DocType);
                  setMissingPage(1);
                }}
              >
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Class" hint="Leave as all to sweep the whole school.">
              <select
                className="input"
                value={missingClass}
                onChange={(e) => {
                  setMissingClass(e.target.value);
                  setMissingPage(1);
                }}
              >
                <option value="">All classes</option>
                {(classes.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {missing.isLoading ? (
            <Spinner />
          ) : missing.error ? (
            <div className="p-5">
              <ErrorNote error={missing.error} />
            </div>
          ) : missingRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={`Every student has a ${LABELS[missingType].toLowerCase()} on file`}
                hint="Nothing outstanding for this type."
              />
            </div>
          ) : (
            <>
              <p className="border-b border-slate-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
                <strong>{missing.data?.meta.total ?? missingRows.length}</strong>{' '}
                {(missing.data?.meta.total ?? 0) === 1 ? 'student has' : 'students have'} no{' '}
                {LABELS[missingType].toLowerCase()} on file. Archived students are not counted.
              </p>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Admission number</th>
                      <th>Class</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {missingRows.map((student) => {
                      const enrollment = student.enrollments[0];
                      return (
                        <tr key={student.id}>
                          <td className="font-medium text-slate-900">
                            {student.firstName} {student.lastName}
                          </td>
                          <td>{student.admissionNumber}</td>
                          <td>
                            {enrollment?.schoolClass?.name ?? '—'}
                            {enrollment?.stream?.name ? ` ${enrollment.stream.name}` : ''}
                          </td>
                          <td className="text-right">
                            {/* Straight to the tab that fixes it. */}
                            <Link
                              to={`/students/${student.id}`}
                              className="text-sm text-brand-700 hover:underline"
                            >
                              Open record
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              {missing.data && (
                <Pagination
                  page={missing.data.meta.page}
                  totalPages={missing.data.meta.totalPages}
                  total={missing.data.meta.total}
                  onChange={setMissingPage}
                />
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}
