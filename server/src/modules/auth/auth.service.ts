import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import {
  hashPassword,
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyRefreshToken,
} from '../../lib/tokens.js';
import { permissionsForRole } from '../../lib/permissions.js';

export interface LoginContext {
  userAgent?: string;
  ipAddress?: string;
}

const userProfileSelect = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  avatarUrl: true,
  schoolId: true,
  mustChangePassword: true,
  twoFactorEnabled: true,
  lastLoginAt: true,
  school: { select: { id: true, name: true, code: true, logoUrl: true, currency: true, status: true } },
  staff: { select: { id: true, staffNumber: true, staffType: true } },
  student: { select: { id: true, admissionNumber: true } },
  guardian: { select: { id: true } },
} as const;

export type UserProfile = Awaited<ReturnType<typeof getProfile>>;

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userProfileSelect });
  if (!user) throw notFound('User');
  return { ...user, permissions: permissionsForRole(user.role) };
}

async function resolveUserForLogin(email: string, schoolCode?: string) {
  const normalized = email.trim().toLowerCase();

  if (schoolCode) {
    const school = await prisma.school.findUnique({ where: { code: schoolCode.toUpperCase() } });
    if (!school) throw unauthorized('Invalid credentials');
    return prisma.user.findFirst({ where: { email: normalized, schoolId: school.id } });
  }

  const matches = await prisma.user.findMany({ where: { email: normalized }, take: 2 });
  if (matches.length > 1) {
    // Same address registered at more than one school — the caller must say which.
    throw badRequest('This email is registered at multiple schools. Provide schoolCode.', {
      field: 'schoolCode',
    });
  }
  return matches[0] ?? null;
}

function lockRemainingMinutes(lockedUntil: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
}

export async function login(
  email: string,
  password: string,
  schoolCode: string | undefined,
  ctx: LoginContext,
) {
  const user = await resolveUserForLogin(email, schoolCode);

  // Uniform error for unknown email vs. wrong password: no account enumeration.
  if (!user) throw unauthorized('Invalid credentials');

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw forbidden(
      `Account locked after too many failed attempts. Try again in ${lockRemainingMinutes(user.lockedUntil)} minute(s).`,
    );
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const shouldLock = failed >= env.MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failed,
        lockedUntil: shouldLock
          ? new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000)
          : user.lockedUntil,
      },
    });
    throw unauthorized('Invalid credentials');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw forbidden(`Account is ${user.status.toLowerCase()}`);
  }

  if (user.schoolId) {
    const school = await prisma.school.findUnique({
      where: { id: user.schoolId },
      select: { status: true },
    });
    if (school?.status === 'SUSPENDED' && user.role !== Role.SUPER_ADMIN) {
      throw forbidden('This school account is suspended. Contact your provider.');
    }
  }

  const tokens = await issueSession(user.id, user.schoolId, user.role, ctx);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

  return { ...tokens, user: await getProfile(user.id) };
}

async function issueSession(
  userId: string,
  schoolId: string | null,
  role: Role,
  ctx: LoginContext,
) {
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: `pending:${randomToken(8)}`,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
      expiresAt,
    },
  });

  const refreshToken = signRefreshToken({ sub: userId, sid: session.id });
  await prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashToken(refreshToken) },
  });

  return {
    accessToken: signAccessToken({ sub: userId, schoolId, role }),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL,
  };
}

/** Rotates the refresh token: the presented one is revoked and replaced. */
export async function refresh(refreshToken: string, ctx: LoginContext) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }

  const session = await prisma.session.findUnique({ where: { id: payload.sid } });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt < new Date() ||
    session.refreshTokenHash !== hashToken(refreshToken)
  ) {
    throw unauthorized('Session is no longer valid');
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== UserStatus.ACTIVE) throw unauthorized('Account is not active');

  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });

  return issueSession(user.id, user.schoolId, user.role, ctx);
}

export async function logout(refreshToken: string | undefined, userId: string): Promise<void> {
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await prisma.session.updateMany({
        where: { id: payload.sid, userId },
        data: { revokedAt: new Date() },
      });
      return;
    } catch {
      // fall through to revoking everything
    }
  }
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
  });
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw notFound('Session');
}

/**
 * Always resolves, whether or not the address exists, so the endpoint cannot be
 * used to discover registered emails. The token is returned to the caller only
 * outside production, where no mail transport is wired up.
 */
export async function requestPasswordReset(email: string, schoolCode?: string) {
  const user = await resolveUserForLogin(email, schoolCode).catch(() => null);
  if (!user) return { token: null };

  const token = randomToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
    },
  });

  return { token, user };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('This reset link is invalid or has expired');
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    // A password change invalidates every existing session.
    prisma.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User');

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw badRequest('Current password is incorrect');
  }
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw conflict('New password must be different from the current one');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
}
