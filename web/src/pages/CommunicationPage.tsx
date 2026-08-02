import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, titleCase } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { SchoolClass } from '../lib/types';

interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  isPinned: boolean;
  author: { firstName: string; lastName: string; role: string } | null;
}

interface Message {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  createdAt: string;
}

interface AnnouncementForm {
  title: string;
  body: string;
  audience: string;
  isPinned: boolean;
}

interface BulkForm {
  channel: string;
  audience: string;
  classId?: string;
  subject?: string;
  body: string;
}

export function CommunicationPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'announcements' | 'outbox'>('announcements');
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const announcements = useQuery({
    queryKey: ['announcements'],
    queryFn: () => get<{ data: Announcement[] }>('/notifications/announcements'),
  });

  const messages = useQuery({
    queryKey: ['messages'],
    queryFn: () => get<{ data: Message[] }>('/notifications/messages?pageSize=100'),
    enabled: tab === 'outbox' && can('communication:read'),
  });

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => get<{ data: SchoolClass[] }>('/academics/classes'),
    enabled: showBulk,
  });

  const announcementForm = useForm<AnnouncementForm>({
    defaultValues: { audience: 'ALL', isPinned: false },
  });

  const createAnnouncement = useMutation({
    mutationFn: (values: AnnouncementForm) =>
      post('/notifications/announcements', {
        title: values.title,
        body: values.body,
        audience: values.audience === 'ALL' ? ['ALL'] : [values.audience],
        isPinned: values.isPinned,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['announcements'] });
      setShowAnnouncement(false);
      announcementForm.reset({ audience: 'ALL', isPinned: false });
    },
  });

  const bulkForm = useForm<BulkForm>({
    defaultValues: { channel: 'SMS', audience: 'ALL_PARENTS' },
  });
  const bulkAudience = bulkForm.watch('audience');

  const sendBulk = useMutation({
    mutationFn: (values: BulkForm) =>
      post<{ queued: number; skipped: number }>('/notifications/messages/bulk', {
        channel: values.channel,
        audience: values.audience,
        classId: values.classId || undefined,
        subject: values.subject || undefined,
        body: values.body,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      setShowBulk(false);
      bulkForm.reset({ channel: 'SMS', audience: 'ALL_PARENTS' });
      setNotice(
        `${result.queued} message(s) queued` +
          (result.skipped ? ` · ${result.skipped} recipient(s) had no usable address` : ''),
      );
    },
  });

  return (
    <>
      <PageHeader
        title="Communication"
        subtitle="Announcements, bulk SMS and the delivery log"
        actions={
          can('communication:send') && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setShowBulk(true)}>
                Bulk message
              </button>
              <button type="button" className="btn-primary" onClick={() => setShowAnnouncement(true)}>
                New announcement
              </button>
            </>
          )
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(
          [
            ['announcements', 'Announcements'],
            ['outbox', 'Message log'],
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

      {tab === 'announcements' &&
        (announcements.isLoading ? (
          <Spinner />
        ) : announcements.error ? (
          <ErrorNote error={announcements.error} />
        ) : announcements.data?.data.length === 0 ? (
          <Card>
            <EmptyState title="No announcements" hint="Post one to reach the whole school." />
          </Card>
        ) : (
          <div className="space-y-4">
            {announcements.data?.data.map((a) => (
              <Card key={a.id}>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-medium text-slate-900">
                    {a.isPinned && <span className="mr-1">📌</span>}
                    {a.title}
                  </h2>
                  <span className="shrink-0 text-xs text-slate-400">{dateTime(a.publishedAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{a.body}</p>
                {a.author && (
                  <p className="mt-3 text-xs text-slate-400">
                    Posted by {a.author.firstName} {a.author.lastName} · {titleCase(a.author.role)}
                  </p>
                )}
              </Card>
            ))}
          </div>
        ))}

      {tab === 'outbox' && (
        <Card padded={false}>
          {messages.isLoading ? (
            <Spinner />
          ) : messages.data?.data.length === 0 ? (
            <EmptyState title="No messages sent yet" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Sent</th>
                    <th>Channel</th>
                    <th>Recipient</th>
                    <th>Message</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.data?.data.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap text-xs">{dateTime(m.createdAt)}</td>
                      <td>{m.channel}</td>
                      <td className="font-mono text-xs">{m.recipient}</td>
                      <td className="max-w-md truncate text-slate-600">{m.body}</td>
                      <td>
                        <Badge status={m.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {showAnnouncement && (
        <Modal title="Post an announcement" onClose={() => setShowAnnouncement(false)}>
          <form
            onSubmit={announcementForm.handleSubmit((v) => createAnnouncement.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {createAnnouncement.error != null && <ErrorNote error={createAnnouncement.error} />}
            <Field label="Title" required>
              <input className="input" {...announcementForm.register('title', { required: true })} />
            </Field>
            <Field label="Message" required>
              <textarea className="input" rows={5} {...announcementForm.register('body', { required: true })} />
            </Field>
            <Field label="Audience" required>
              <select className="input" {...announcementForm.register('audience')}>
                <option value="ALL">Everyone</option>
                <option value="PARENT">Parents only</option>
                <option value="STUDENT">Students only</option>
                <option value="TEACHER">Teachers only</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" {...announcementForm.register('isPinned')} />
              Pin to the top of the noticeboard
            </label>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowAnnouncement(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createAnnouncement.isPending}>
                Post announcement
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showBulk && (
        <Modal title="Send a bulk message" onClose={() => setShowBulk(false)}>
          <form
            onSubmit={bulkForm.handleSubmit((v) => sendBulk.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {sendBulk.error != null && <ErrorNote error={sendBulk.error} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Channel" required>
                <select className="input" {...bulkForm.register('channel')}>
                  <option value="SMS">SMS</option>
                  <option value="EMAIL">Email</option>
                </select>
              </Field>
              <Field label="Audience" required>
                <select className="input" {...bulkForm.register('audience')}>
                  <option value="ALL_PARENTS">All parents</option>
                  <option value="CLASS_PARENTS">Parents of one class</option>
                  <option value="FEE_DEFAULTERS">Parents with outstanding fees</option>
                  <option value="ALL_STAFF">All staff</option>
                </select>
              </Field>
            </div>

            {bulkAudience === 'CLASS_PARENTS' && (
              <Field label="Class" required>
                <select className="input" {...bulkForm.register('classId', { required: true })}>
                  <option value="">Select…</option>
                  {classes.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {bulkForm.watch('channel') === 'EMAIL' && (
              <Field label="Subject">
                <input className="input" {...bulkForm.register('subject')} />
              </Field>
            )}

            <Field
              label="Message"
              required
              hint="Placeholders: {{guardianName}}, {{studentName}}, {{balance}}, {{invoiceNumber}}"
            >
              <textarea className="input" rows={4} {...bulkForm.register('body', { required: true })} />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowBulk(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={sendBulk.isPending}>
                {sendBulk.isPending ? 'Queueing…' : 'Send message'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
