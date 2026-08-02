import { Router } from 'express';
import { MessageChannel, MessageStatus, Role, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { normalizePhone, queueMessages, renderTemplate } from './message.service.js';

/** Module 16 — Communication: announcements, templates and bulk messaging. */
export const communicationRouter: Router = Router();

// --- Announcements ----------------------------------------------------------

communicationRouter.get(
  '/announcements',
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const role = req.user!.role;

    const data = await prisma.announcement.findMany({
      where: {
        schoolId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
      include: { author: { select: { firstName: true, lastName: true, role: true } } },
    });

    // Audience is stored as a JSON array of roles; "ALL" reaches everyone.
    const visible = data.filter((a) => {
      const audience = Array.isArray(a.audience) ? (a.audience as string[]) : ['ALL'];
      return audience.includes('ALL') || audience.includes(role);
    });

    res.json({ data: visible });
  }),
);

communicationRouter.post(
  '/announcements',
  requirePermission('communication:send'),
  validate(
    z.object({
      title: z.string().min(2).max(200),
      body: z.string().min(2).max(5000),
      audience: z.array(z.string()).min(1).default(['ALL']),
      expiresAt: z.coerce.date().nullish(),
      isPinned: z.boolean().default(false),
    }),
  ),
  asyncHandler(async (req, res) => {
    const announcement = await prisma.announcement.create({
      data: {
        ...req.body,
        schoolId: schoolIdOf(req),
        authorId: req.user?.id ?? null,
      },
    });
    await audit(req, { action: 'announcement.create', entityType: 'Announcement', entityId: announcement.id });
    res.status(201).json(announcement);
  }),
);

// --- Templates --------------------------------------------------------------

communicationRouter.get(
  '/templates',
  requirePermission('communication:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.messageTemplate.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
    });
    res.json({ data });
  }),
);

communicationRouter.post(
  '/templates',
  requirePermission('communication:send'),
  validate(
    z.object({
      name: z.string().min(2).max(80),
      channel: z.nativeEnum(MessageChannel),
      subject: z.string().max(200).nullish(),
      body: z.string().min(2).max(2000),
    }),
  ),
  asyncHandler(async (req, res) => {
    const template = await prisma.messageTemplate.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    res.status(201).json(template);
  }),
);

// --- Bulk messaging ---------------------------------------------------------

const bulkSchema = z.object({
  channel: z.nativeEnum(MessageChannel).default(MessageChannel.SMS),
  subject: z.string().max(200).optional(),
  body: z.string().min(2).max(2000),
  audience: z.enum(['ALL_PARENTS', 'ALL_STAFF', 'CLASS_PARENTS', 'FEE_DEFAULTERS', 'CUSTOM']),
  classId: z.string().optional(),
  recipients: z.array(z.string()).optional(),
});

communicationRouter.post(
  '/messages/bulk',
  requirePermission('communication:send'),
  validate(bulkSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof bulkSchema>;

    let targets: Array<{ recipient: string; vars: Record<string, string | number> }> = [];

    switch (body.audience) {
      case 'ALL_PARENTS': {
        const guardians = await prisma.guardian.findMany({
          where: { schoolId },
          select: { firstName: true, lastName: true, phone: true, email: true },
        });
        targets = guardians.map((g) => ({
          recipient:
            body.channel === MessageChannel.EMAIL ? (g.email ?? '') : normalizePhone(g.phone),
          vars: { guardianName: `${g.firstName} ${g.lastName}` },
        }));
        break;
      }

      case 'CLASS_PARENTS': {
        if (!body.classId) throw badRequest('classId is required for CLASS_PARENTS');
        const links = await prisma.studentGuardian.findMany({
          where: {
            student: {
              schoolId,
              status: StudentStatus.ACTIVE,
              enrollments: { some: { isActive: true, classId: body.classId } },
            },
          },
          include: {
            guardian: { select: { firstName: true, lastName: true, phone: true, email: true } },
            student: { select: { firstName: true, lastName: true } },
          },
        });
        targets = links.map((l) => ({
          recipient:
            body.channel === MessageChannel.EMAIL
              ? (l.guardian.email ?? '')
              : normalizePhone(l.guardian.phone),
          vars: {
            guardianName: `${l.guardian.firstName} ${l.guardian.lastName}`,
            studentName: `${l.student.firstName} ${l.student.lastName}`,
          },
        }));
        break;
      }

      case 'FEE_DEFAULTERS': {
        const invoices = await prisma.invoice.findMany({
          where: { schoolId, balance: { gt: 0 }, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
          include: {
            student: {
              select: {
                firstName: true,
                lastName: true,
                guardianLinks: {
                  where: { isFeePayer: true },
                  include: { guardian: { select: { firstName: true, lastName: true, phone: true, email: true } } },
                },
              },
            },
          },
        });
        targets = invoices.flatMap((inv) =>
          inv.student.guardianLinks.map((l) => ({
            recipient:
              body.channel === MessageChannel.EMAIL
                ? (l.guardian.email ?? '')
                : normalizePhone(l.guardian.phone),
            vars: {
              guardianName: `${l.guardian.firstName} ${l.guardian.lastName}`,
              studentName: `${inv.student.firstName} ${inv.student.lastName}`,
              balance: inv.balance.toString(),
              invoiceNumber: inv.invoiceNumber,
            },
          })),
        );
        break;
      }

      case 'ALL_STAFF': {
        const staff = await prisma.staff.findMany({
          where: { schoolId, employmentStatus: 'ACTIVE' },
          select: { firstName: true, lastName: true, phone: true, email: true },
        });
        targets = staff
          .filter((s) => (body.channel === MessageChannel.EMAIL ? s.email : s.phone))
          .map((s) => ({
            recipient:
              body.channel === MessageChannel.EMAIL ? s.email! : normalizePhone(s.phone!),
            vars: { staffName: `${s.firstName} ${s.lastName}` },
          }));
        break;
      }

      case 'CUSTOM': {
        if (!body.recipients?.length) throw badRequest('recipients is required for CUSTOM');
        targets = body.recipients.map((r) => ({
          recipient: body.channel === MessageChannel.EMAIL ? r : normalizePhone(r),
          vars: {},
        }));
        break;
      }
    }

    // Drop anyone with no usable address on the chosen channel.
    const deliverable = targets.filter((t) => t.recipient.length > 3);
    if (deliverable.length === 0) throw badRequest('No recipients have a usable address for this channel');

    const result = await queueMessages(
      schoolId,
      deliverable.map((t) => ({
        channel: body.channel,
        recipient: t.recipient,
        subject: body.subject ?? null,
        body: renderTemplate(body.body, t.vars),
      })),
    );

    await audit(req, {
      action: 'message.bulk_send',
      metadata: { audience: body.audience, channel: body.channel, count: result.queued },
    });

    res.status(202).json({
      ...result,
      skipped: targets.length - deliverable.length,
    });
  }),
);

/** Outbox / delivery log. */
communicationRouter.get(
  '/messages',
  requirePermission('communication:read'),
  validate(
    paginationSchema.extend({
      channel: z.nativeEnum(MessageChannel).optional(),
      status: z.nativeEnum(MessageStatus).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      channel?: MessageChannel;
      status?: MessageStatus;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.message.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.message.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

/** In-app notifications for the signed-in user. */
communicationRouter.get(
  '/inbox',
  asyncHandler(async (req, res) => {
    const data = await prisma.message.findMany({
      where: {
        schoolId: schoolIdOf(req),
        channel: MessageChannel.IN_APP,
        recipientUserId: req.user!.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data });
  }),
);

/** Direct in-app message to specific users (used by teacher/parent messaging). */
communicationRouter.post(
  '/messages/direct',
  validate(
    z.object({
      userIds: z.array(z.string().min(1)).min(1).max(200),
      subject: z.string().max(200).optional(),
      body: z.string().min(1).max(2000),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { userIds, subject, body } = req.body as {
      userIds: string[];
      subject?: string;
      body: string;
    };

    const recipients = await prisma.user.findMany({
      where: { id: { in: userIds }, schoolId, role: { not: Role.SUPER_ADMIN } },
      select: { id: true, email: true },
    });
    if (recipients.length === 0) throw badRequest('No valid recipients in this school');

    const result = await queueMessages(
      schoolId,
      recipients.map((r) => ({
        channel: MessageChannel.IN_APP,
        recipient: r.email,
        recipientUserId: r.id,
        subject: subject ?? null,
        body,
      })),
    );

    res.status(202).json(result);
  }),
);
