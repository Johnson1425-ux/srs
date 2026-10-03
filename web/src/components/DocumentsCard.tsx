import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, qs, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import { Card, EmptyState, ErrorNote, Field, Spinner, TableWrap } from './ui';
import {
  DOC_TYPES,
  type DocType,
  type FileLink,
  type Paginated,
  type SchoolDocument,
  type StorageUsageResponse,
} from '../lib/types';

/** Bytes as a school secretary would read them, not as a kernel reports them. */
function fileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LABELS: Record<DocType, string> = {
  BIRTH_CERTIFICATE: 'Birth certificate',
  LEAVING_CERTIFICATE: 'Leaving certificate',
  MEDICAL_REPORT: 'Medical report',
  CONTRACT: 'Contract',
  ID_COPY: 'ID copy',
  RESULT_SLIP: 'Result slip',
  OTHER: 'Other',
};

/**
 * The files held for one student or staff member.
 *
 * Downloads go through a link the API signs on request rather than a URL kept
 * in the page: the link expires in minutes, so one that has been sitting in an
 * open tab is refetched rather than failing silently.
 */
export function DocumentsCard({
  subject,
  subjectId,
  variant = 'card',
}: {
  subject: 'student' | 'staff';
  subjectId: string;
  /**
   * `bare` drops the surrounding Card, for when this already sits inside one —
   * a modal, say, which brings its own heading and padding.
   */
  variant?: 'card' | 'bare';
}) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [docType, setDocType] = useState<DocType>('BIRTH_CERTIFICATE');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const canManage = can('documents:manage');
  const scope = subject === 'student' ? { studentId: subjectId } : { staffId: subjectId };
  const listKey = ['documents', subject, subjectId];

  const documents = useQuery({
    queryKey: listKey,
    queryFn: () => get<Paginated<SchoolDocument>>(`/documents${qs({ ...scope, pageSize: 100 })}`),
    enabled: can('documents:read'),
  });

  // The quota and the accepted types come from the server so the form states
  // the same limits it will be held to.
  const usage = useQuery({
    queryKey: ['documents', 'usage'],
    queryFn: () => get<StorageUsageResponse>('/documents/usage'),
    enabled: canManage,
    retry: false,
  });

  const reset = () => {
    setTitle('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const send = useMutation({
    mutationFn: () =>
      upload<SchoolDocument>('/documents/upload', file!, { ...scope, docType, title }),
    onSuccess: async () => {
      reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: ['documents', 'usage'] }),
      ]);
    },
  });

  const remove = useMutation({
    mutationFn: (documentId: string) => del(`/documents/${documentId}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: ['documents', 'usage'] }),
      ]);
    },
  });

  /**
   * Opens a document.
   *
   * The signed URL is fetched at the moment of the click, which is why this is
   * a button rather than an anchor — an href rendered with the list would have
   * expired by the time anyone pressed it.
   */
  const open = useMutation({
    mutationFn: async (documentId: string) => {
      const link = await get<FileLink>(`/documents/${documentId}/file`);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
  });

  const accept = usage.data?.acceptedTypes.join(',') ?? 'image/jpeg,image/png,image/webp,application/pdf';
  const rows = documents.data?.data ?? [];

  const quotaNote = usage.data && (
    <span className="text-xs text-slate-500">
      {usage.data.usedMb}MB of {usage.data.quotaMb}MB used
    </span>
  );

  const body = (
    <>
      {variant === 'bare' && quotaNote && <p className="mb-3 text-right">{quotaNote}</p>}

      {canManage && (
        <form
          className="mb-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) send.mutate();
          }}
        >
          <Field label="Document type" required>
            <select
              className="input"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocType)}
            >
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LABELS[t]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Title" required>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Birth certificate"
              minLength={2}
              maxLength={200}
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="File"
              required
              hint={
                usage.data
                  ? `JPEG, PNG, WebP or PDF, up to ${usage.data.maxUploadMb}MB.`
                  : 'JPEG, PNG, WebP or PDF.'
              }
            >
              <input
                ref={fileInput}
                type="file"
                className="input"
                accept={accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
            </Field>
          </div>

          {send.error != null && (
            <div className="sm:col-span-2">
              <ErrorNote error={send.error} />
            </div>
          )}

          <div className="sm:col-span-2 text-right">
            <button
              type="submit"
              className="btn-primary px-4 py-2 text-sm"
              disabled={send.isPending || !file || title.trim().length < 2}
            >
              {send.isPending ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      )}

      {remove.error != null && (
        <div className="mb-4">
          <ErrorNote error={remove.error} />
        </div>
      )}
      {open.error != null && (
        <div className="mb-4">
          <ErrorNote error={open.error} />
        </div>
      )}

      {documents.isLoading ? (
        <Spinner />
      ) : documents.error ? (
        <ErrorNote error={documents.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No documents on file"
          hint={
            canManage
              ? 'Upload a birth certificate, medical report or any other scan above.'
              : 'Nothing has been filed for this record yet.'
          }
        />
      ) : (
        <TableWrap>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4">Title</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Size</th>
                <th className="py-2 pr-4">Filed</th>
                <th className="py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((doc) => (
                <tr key={doc.id}>
                  <td className="py-2 pr-4 font-medium text-slate-900">
                    {doc.title}
                    {doc.storedFile && (
                      <span className="block text-xs font-normal text-slate-500">
                        {doc.storedFile.filename}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{LABELS[doc.docType] ?? doc.docType}</td>
                  <td className="py-2 pr-4 text-slate-600">
                    {fileSize(doc.storedFile?.sizeBytes ?? doc.sizeBytes)}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{date(doc.createdAt)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="text-sm text-brand-700 hover:underline disabled:opacity-50"
                      disabled={open.isPending}
                      onClick={() => open.mutate(doc.id)}
                    >
                      Open
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        className="ml-3 text-sm text-red-700 hover:underline disabled:opacity-50"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete “${doc.title}”? This cannot be undone.`)) {
                            remove.mutate(doc.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );

  if (variant === 'bare') return body;

  return (
    <Card title="Documents" actions={quotaNote}>
      {body}
    </Card>
  );
}
