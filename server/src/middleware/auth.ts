import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { type Permission, permissionsForRole, roleHasPermission } from '../lib/permissions.js';

export interface AuthenticatedUser {
  id: string;
  schoolId: string | null;
  role: Role;
  email: string;
  firstName: string;
  lastName: string;
  permissions: Permission[];
  staffId?: string | null;
  studentId?: string | null;
  guardianId?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/** Verifies the access token and loads the caller with their profile links. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) throw unauthorized('Missing bearer token');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        schoolId: true,
        role: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        staff: { select: { id: true } },
        student: { select: { id: true } },
        guardian: { select: { id: true } },
        school: { select: { status: true } },
      },
    });

    if (!user) throw unauthorized('Account no longer exists');
    if (user.status !== UserStatus.ACTIVE) {
      throw forbidden(`Account is ${user.status.toLowerCase()}`);
    }
    // A suspended tenant locks out everyone except platform staff.
    if (user.role !== Role.SUPER_ADMIN && user.school && user.school.status === 'SUSPENDED') {
      throw forbidden('This school account is suspended. Contact your provider.');
    }

    req.user = {
      id: user.id,
      schoolId: user.schoolId,
      role: user.role,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      permissions: permissionsForRole(user.role),
      staffId: user.staff?.id ?? null,
      studentId: user.student?.id ?? null,
      guardianId: user.guardian?.id ?? null,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Requires one of the given permissions (SUPER_ADMIN always passes). */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(unauthorized());
    const allowed = permissions.some((p) => roleHasPermission(user.role, p));
    if (!allowed) {
      return next(forbidden(`Requires one of: ${permissions.join(', ')}`));
    }
    return next();
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(unauthorized());
    if (user.role !== Role.SUPER_ADMIN && !roles.includes(user.role)) {
      return next(forbidden(`Requires role: ${roles.join(', ')}`));
    }
    return next();
  };
}

/**
 * Resolves the tenant for the request. Normal users are pinned to their own
 * school; SUPER_ADMIN may target any school via the `X-School-Id` header.
 */
export function schoolIdOf(req: Request): string {
  const user = req.user;
  if (!user) throw unauthorized();
  if (user.role === Role.SUPER_ADMIN) {
    const header = req.header('X-School-Id');
    if (header) return header;
    if (user.schoolId) return user.schoolId;
    throw forbidden('Super admin must select a school via the X-School-Id header');
  }
  if (!user.schoolId) throw forbidden('Account is not attached to a school');
  return user.schoolId;
}

/** Guarantees a school context exists before the handler runs. */
export const requireSchool: RequestHandler = (req, _res, next) => {
  try {
    schoolIdOf(req);
    next();
  } catch (err) {
    next(err);
  }
};
