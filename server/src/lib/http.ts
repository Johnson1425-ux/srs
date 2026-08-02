import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/** Wraps async handlers so rejected promises reach the error middleware. */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

type Source = 'body' | 'query' | 'params';

/** Validates and *replaces* the request segment with the parsed (typed) value. */
export function validate(schema: ZodTypeAny, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      return next(badRequest('Validation failed', details));
    }
    if (source === 'query') {
      // req.query has only a getter in Express 5-style setups; keep it safe.
      Object.defineProperty(req, 'query', { value: result.data, writable: true });
    } else {
      req[source] = result.data as never;
    }
    return next();
  };
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export function paginate<T>(data: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    data,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export function skipTake(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
