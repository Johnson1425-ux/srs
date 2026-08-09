import { Router } from 'express';
import { Role, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** User administration within a school (Module 1 / Module 4 — user management). */
export const userRouter: Router = Router();

const listQuery = paginationSchema.extend({
  search: z.string().trim().optional(),
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

userRouter.get(
  '/',
  requirePermission('users:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search, role, status } = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      schoolId: schoolIdOf(req),
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          // Shown so an administrator can tell "cannot sign in" apart from
          // "locked out by failed attempts" without reading the database.
          lockedUntil: true,
          mustChangePassword: true,
          _count: { select: { sessions: { where: { revokedAt: null } } } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(paginate(data, total, page, pageSize));
  }),
);

const createUserSchema = z.object({
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.nativeEnum(Role),
  password: z.string().min(8).optional(),
});

userRouter.post(
  '/',
  requirePermission('users:manage'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof createUserSchema>;

    if (body.role === Role.SUPER_ADMIN) {
      throw badRequest('Super admin accounts are created from platform administration');
    }

    // When no password is supplied the account is created with a one-time
    // password the administrator hands over, and a forced change on first login.
    const temporaryPassword = body.password ?? `Sms-${randomToken(4)}`;

    const user = await prisma.user.create({
      data: {
        schoolId,
        email: body.email.toLowerCase(),
        phone: body.phone ?? null,
        firstName: body.firstName,
        lastName: body.lastName,
        role: body.role,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: !body.password,
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true },
    });

    await audit(req, { action: 'user.create', entityType: 'User', entityId: user.id });
    res.status(201).json({ ...user, ...(body.password ? {} : { temporaryPassword }) });
  }),
);

const updateUserSchema = z.object({
  phone: z.string().max(30).nullish(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  avatarUrl: z.string().url().nullish(),
});

userRouter.patch(
  '/:id',
  requirePermission('users:manage'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('User');
    if (req.body.role === Role.SUPER_ADMIN) throw badRequest('Cannot assign the super admin role');

    // Nobody may demote or disable themselves. The only administrator doing
    // either locks the school out of its own system with no way back in.
    if (id === req.user?.id) {
      if (req.body.role && req.body.role !== existing.role) {
        throw badRequest('You cannot change your own role. Ask another administrator.');
      }
      if (req.body.status && req.body.status !== existing.status) {
        throw badRequest('You cannot change your own account status.');
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: req.body,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true },
    });

    // Deactivating an account must also kill its live sessions.
    if (req.body.status && req.body.status !== UserStatus.ACTIVE) {
      await prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await audit(req, { action: 'user.update', entityType: 'User', entityId: id, metadata: req.body });
    res.json(user);
  }),
);

userRouter.post(
  '/:id/reset-password',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const existing = await prisma.user.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('User');

    const temporaryPassword = `Sms-${randomToken(4)}`;
    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: {
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await audit(req, { action: 'user.reset_password', entityType: 'User', entityId: id });
    res.json({ temporaryPassword });
  }),
);

/**
 * Signs an account out of every device without changing its password. For a
 * lost or stolen phone, where the account itself is fine.
 */
userRouter.post(
  '/:id/revoke-sessions',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('User');

    const result = await prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await audit(req, {
      action: 'user.revoke_sessions',
      entityType: 'User',
      entityId: id,
      metadata: { revoked: result.count },
    });
    res.json({ revoked: result.count });
  }),
);

/**
 * Clears a lockout from repeated failed sign-ins, leaving the password alone —
 * for someone who mistyped it five times and now remembers it.
 */
userRouter.post(
  '/:id/unlock',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('User');

    await prisma.user.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    await audit(req, { action: 'user.unlock', entityType: 'User', entityId: id });
    res.json({ unlocked: true });
  }),
);

/**
 * Deletes an account outright — but only one that never did anything.
 *
 * Every consequential action is recorded against the user who took it, so
 * removing someone who has used the system would leave payments and results
 * attributed to nobody. That is precisely what an audit trail exists to
 * prevent, so an account with any history is disabled instead, which keeps
 * the record and stops the sign-in just as effectively. Deletion remains
 * available for the real case it serves: an account created by mistake.
 */
userRouter.delete(
  '/:id',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('User');
    if (id === req.user?.id) throw badRequest('You cannot delete your own account.');

    const [auditCount, announcementCount] = await Promise.all([
      prisma.auditLog.count({ where: { userId: id } }),
      prisma.announcement.count({ where: { authorId: id } }),
    ]);

    if (existing.lastLoginAt || auditCount > 0 || announcementCount > 0) {
      throw badRequest(
        'This account has been used, so deleting it would leave its actions ' +
          'recorded against nobody. Disable it instead — that stops the sign-in ' +
          'and keeps the history.',
      );
    }

    await prisma.user.delete({ where: { id } });

    await audit(req, {
      action: 'user.delete',
      entityType: 'User',
      entityId: id,
      metadata: { email: existing.email, role: existing.role },
    });
    res.status(204).send();
  }),
);
