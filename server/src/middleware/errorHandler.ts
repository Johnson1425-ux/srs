import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}` },
  });
};

function describePrismaError(err: Prisma.PrismaClientKnownRequestError): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  const target = (err.meta?.target as string[] | string | undefined) ?? undefined;
  switch (err.code) {
    case 'P2002':
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'A record with these unique values already exists',
        details: { fields: target },
      };
    case 'P2003':
      return {
        status: 400,
        code: 'FOREIGN_KEY_VIOLATION',
        message: 'Referenced record does not exist',
        details: { field: err.meta?.field_name },
      };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
    default:
      return { status: 400, code: `PRISMA_${err.code}`, message: err.message.split('\n').pop() ?? err.message };
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const { status, code, message, details } = describePrismaError(err);
    res.status(status).json({ error: { code, message, details } });
    return;
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({
      error: { code: 'INVALID_QUERY', message: 'The request contained invalid field values' },
    });
    return;
  }

  // Anything reaching here is a genuine bug: log it with request context.
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      ...(isProduction ? {} : { detail: (err as Error)?.message, stack: (err as Error)?.stack }),
    },
  });
};
