import { type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, statusTone, titleCase } from '../lib/format';
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
  attempts: number;
  error: string | null;
  cost: string | null;
}

interface ChannelStatus {
  provider: string;
  configured: boolean;
  maxAttempts: number;
  counts: Record<string, number>;
}

interface DeliveryStatus {
  sms: ChannelStatus & { sandbox: boolean; senderId: string; senderIdWarning: string | null };
  email: ChannelStatus & { from: string | null; replyTo: string | null };
}

interface DispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

interface DispatchResult {
  sms: DispatchSummary | null;
  email: DispatchSummary | null;
}

/** Just enough of a mutation to drive one card's two buttons. */
interface ChannelMutation {
  mutate: (channel: 'SMS' | 'EMAIL') => void;
  isPending: boolean;
  variables?: 'SMS' | 'EMAIL';
}

/**
 * One transport's state and controls. SMS and email fail for different reasons
 * and are configured separately, so each gets its own queue counts and its own
 * send button rather than a combined one that hides which half is broken.
 */
function TransportCard({
  title,
  channel,
  status,
  heading,
  detail,
  warning,
  unconfigured,
  canSend,
  dispatch,
  retry,
}: {
  title: string;
  channel: 'SMS' | 'EMAIL';
  status: ChannelStatus;
  heading: ReactNode;
  detail: string;
  warning: string | null;
  unconfigured: string;
  canSend: boolean;
  dispatch: ChannelMutation;
  retry: ChannelMutation;
}) {
  // Only the card that was clicked should say "Sending…".
  const sending = dispatch.isPending && dispatch.variables === channel;
  const retrying = retry.isPending && retry.variables === channel;
  const failed = status.counts.FAILED ?? 0;

  return (
    <Card>
      <p className="text-sm font-medium text-slate-800">
        {status.configured ? heading : `No ${title} configured`}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {status.configured
          ? `${detail} · up to ${status.maxAttempts} attempts per message`
          : unconfigured}
      </p>
      {warning != null && <p className="mt-1 text-xs text-amber-700">{warning}</p>}

      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {Object.entries(status.counts).length === 0 ? (
          <span className="text-xs text-slate-400">Nothing queued</span>
        ) : (
          Object.entries(status.counts).map(([state, count]) => (
            <span key={state} className={`badge ${statusTone(state)}`}>
              {titleCase(state)}: {count}
            </span>
          ))
        )}
      </div>

      {canSend && status.configured && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={sending}
            onClick={() => dispatch.mutate(channel)}
          >
            {sending ? 'Sending…' : 'Send queued now'}
          </button>
          {failed > 0 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={retrying}
              onClick={() => retry.mutate(channel)}
            >
              {retrying ? 'Retrying…' : `Retry ${failed} failed`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Folds a per-channel dispatch response into one line for the notice bar. */
function summarise(result: DispatchResult, prefix = ''): string {
  const parts = (['sms', 'email'] as const)
    .map((channel) => ({ channel, summary: result[channel] }))
    .filter((c) => c.summary != null && !c.summary.skipped && c.summary.attempted > 0)
    .map(
      ({ channel, summary }) =>
        `${channel === 'sms' ? 'SMS' : 'Email'}: ${summary!.sent} sent, ${summary!.failed} failed`,
    );

  if (parts.length === 0) return `${prefix}Nothing was queued to send.`;
  return prefix + parts.join(' · ');
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

  const deliveryStatus = useQuery({
    queryKey: ['delivery-status'],
    queryFn: () => get<DeliveryStatus>('/notifications/messages/status'),
    enabled: can('communication:read'),
  });

  const refreshOutbox = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
    void queryClient.invalidateQueries({ queryKey: ['delivery-status'] });
  };

  const dispatchNow = useMutation({
    mutationFn: (channel: 'SMS' | 'EMAIL') =>
      post<DispatchResult>('/notifications/messages/dispatch', { channel }),
    onSuccess: (r) => {
      refreshOutbox();
      setNotice(summarise(r));
    },
  });

  const retryFailed = useMutation({
    mutationFn: (channel: 'SMS' | 'EMAIL') =>
      post<DispatchResult & { requeued: number }>('/notifications/messages/retry-failed', {
        channel,
      }),
    onSuccess: (r) => {
      refreshOutbox();
      setNotice(summarise(r, `Requeued ${r.requeued} — `));
    },
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
        subtitle="Announcements, bulk SMS and email, and the delivery log"
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
        <>
          {deliveryStatus.data && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <TransportCard
                title="SMS gateway"
                channel="SMS"
                status={deliveryStatus.data.sms}
                heading={
                  <>
                    SMS gateway: {titleCase(deliveryStatus.data.sms.provider)}
                    {deliveryStatus.data.sms.sandbox && (
                      <span className="badge ml-2 bg-amber-100 text-amber-800">Sandbox</span>
                    )}
                  </>
                }
                detail={
                  deliveryStatus.data.sms.senderId
                    ? `Sender ID ${deliveryStatus.data.sms.senderId}`
                    : 'Sending as the account default'
                }
                warning={deliveryStatus.data.sms.senderIdWarning}
                unconfigured="Messages are recorded here but not delivered. Set SMS_PROVIDER and its credentials to enable sending."
                canSend={can('communication:send')}
                dispatch={dispatchNow}
                retry={retryFailed}
              />

              <TransportCard
                title="email transport"
                channel="EMAIL"
                status={deliveryStatus.data.email}
                heading={<>Email: {titleCase(deliveryStatus.data.email.provider)}</>}
                detail={
                  deliveryStatus.data.email.from
                    ? `From ${deliveryStatus.data.email.from}${
                        deliveryStatus.data.email.replyTo
                          ? ` · replies to ${deliveryStatus.data.email.replyTo}`
                          : ''
                      }`
                    : 'No From address set'
                }
                warning={
                  deliveryStatus.data.email.configured && !deliveryStatus.data.email.replyTo
                    ? 'This school has no email address, so replies go to the sending account. Add one under Settings.'
                    : null
                }
                unconfigured="Email is recorded here but not delivered. Set EMAIL_PROVIDER=smtp with SMTP_HOST and SMTP_FROM to enable sending."
                canSend={can('communication:send')}
                dispatch={dispatchNow}
                retry={retryFailed}
              />
            </div>
          )}

          {(dispatchNow.error ?? retryFailed.error) != null && (
            <div className="mb-4">
              <ErrorNote error={dispatchNow.error ?? retryFailed.error} />
            </div>
          )}

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
                      <th>Queued</th>
                      <th>Channel</th>
                      <th>Recipient</th>
                      <th>Message</th>
                      <th>Status</th>
                      <th className="text-right">Cost</th>
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
                          {m.error && (
                            // Wrapped rather than truncated: a gateway's
                            // rejection is the one thing here worth reading in
                            // full, and a hover tooltip is no use on a phone.
                            <span className="block max-w-[20rem] whitespace-pre-wrap break-words text-xs text-red-600">
                              {m.error}
                            </span>
                          )}
                          {m.attempts > 1 && (
                            <span className="block text-xs text-slate-400">
                              {m.attempts} attempts
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right text-xs text-slate-500">
                          {m.cost ?? '—'}
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
