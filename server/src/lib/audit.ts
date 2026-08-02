import type { Request } from 'express';
import { prisma } from '../db/prisma.js';

interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records an audit trail entry (PRD section 6 — Security: audit logs).
 * Auditing must never break the operation it describes, so failures are
 * logged and swallowed.
 */
export async function audit(req: Request, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        schoolId: req.user?.schoolId ?? null,
        userId: req.user?.id ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: (input.metadata ?? undefined) as never,
        ipAddress: req.ip ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log', err);
  }
}
