import { Router } from 'express';
import { LoanStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { money, round } from '../../lib/money.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/** Module 12 — Library. */
export const libraryRouter: Router = Router();

/** Fine charged per day a book is kept past its due date. */
const FINE_PER_DAY = 500; // TZS

function daysLate(dueDate: Date, returnedAt: Date): number {
  const ms = returnedAt.getTime() - dueDate.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

// --- Books ------------------------------------------------------------------

libraryRouter.get(
  '/books',
  requirePermission('library:read'),
  validate(
    paginationSchema.extend({
      search: z.string().trim().optional(),
      category: z.string().optional(),
      availableOnly: z.coerce.boolean().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      search?: string;
      category?: string;
      availableOnly?: boolean;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.category ? { category: q.category } : {}),
      ...(q.availableOnly ? { availableCopies: { gt: 0 } } : {}),
      ...(q.search
        ? {
            OR: [
              { title: { contains: q.search, mode: 'insensitive' as const } },
              { author: { contains: q.search, mode: 'insensitive' as const } },
              { isbn: { contains: q.search } },
              { barcode: { contains: q.search } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.book.findMany({ where, ...skipTake(q.page, q.pageSize), orderBy: { title: 'asc' } }),
      prisma.book.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

const bookSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().max(120).nullish(),
  isbn: z.string().max(20).nullish(),
  barcode: z.string().max(60).nullish(),
  category: z.string().max(60).nullish(),
  publisher: z.string().max(120).nullish(),
  edition: z.string().max(40).nullish(),
  shelf: z.string().max(40).nullish(),
  totalCopies: z.number().int().min(1).default(1),
});

libraryRouter.post(
  '/books',
  requirePermission('library:manage'),
  validate(bookSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof bookSchema>;
    const book = await prisma.book.create({
      data: { ...body, schoolId: schoolIdOf(req), availableCopies: body.totalCopies },
    });
    await audit(req, { action: 'book.create', entityType: 'Book', entityId: book.id });
    res.status(201).json(book);
  }),
);

libraryRouter.patch(
  '/books/:id',
  requirePermission('library:manage'),
  validate(bookSchema.partial()),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const existing = await prisma.book.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('Book');

    // Keep availability consistent when the total stock changes.
    const onLoan = existing.totalCopies - existing.availableCopies;
    const totalCopies = req.body.totalCopies ?? existing.totalCopies;
    if (totalCopies < onLoan) {
      throw badRequest(`${onLoan} copies are currently on loan; total cannot be lower`);
    }

    const book = await prisma.book.update({
      where: { id },
      data: { ...req.body, availableCopies: totalCopies - onLoan },
    });
    res.json(book);
  }),
);

// --- Borrowing and returns --------------------------------------------------

libraryRouter.get(
  '/loans',
  requirePermission('library:read'),
  validate(
    paginationSchema.extend({
      status: z.nativeEnum(LoanStatus).optional(),
      studentId: z.string().optional(),
      overdueOnly: z.coerce.boolean().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: LoanStatus;
      studentId?: string;
      overdueOnly?: boolean;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.status ? { status: q.status } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.overdueOnly
        ? { status: LoanStatus.BORROWED, dueDate: { lt: new Date() } }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.bookLoan.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { borrowedAt: 'desc' },
        include: {
          book: { select: { id: true, title: true, author: true } },
          student: { select: { id: true, admissionNumber: true, firstName: true, lastName: true } },
        },
      }),
      prisma.bookLoan.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

libraryRouter.post(
  '/loans',
  requirePermission('library:manage'),
  validate(
    z.object({
      bookId: z.string().min(1),
      studentId: z.string().nullish(),
      borrowerName: z.string().max(120).nullish(),
      dueDate: z.coerce.date(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { bookId, studentId, borrowerName, dueDate } = req.body as {
      bookId: string;
      studentId?: string | null;
      borrowerName?: string | null;
      dueDate: Date;
    };
    if (!studentId && !borrowerName) throw badRequest('Provide studentId or borrowerName');

    const loan = await prisma.$transaction(async (tx) => {
      const book = await tx.book.findFirst({ where: { id: bookId, schoolId } });
      if (!book) throw notFound('Book');
      if (book.availableCopies < 1) throw conflict('No copies of this book are available');

      if (studentId) {
        const student = await tx.student.findFirst({ where: { id: studentId, schoolId } });
        if (!student) throw notFound('Student');

        const outstanding = await tx.bookLoan.count({
          where: { studentId, status: LoanStatus.BORROWED },
        });
        if (outstanding >= 3) {
          throw conflict('This student already has 3 books on loan');
        }
      }

      await tx.book.update({
        where: { id: bookId },
        data: { availableCopies: { decrement: 1 } },
      });

      return tx.bookLoan.create({
        data: {
          schoolId,
          bookId,
          studentId: studentId ?? null,
          borrowerName: borrowerName ?? null,
          dueDate,
          issuedById: req.user?.id ?? null,
        },
        include: { book: { select: { title: true } } },
      });
    });

    await audit(req, { action: 'library.issue', entityType: 'BookLoan', entityId: loan.id });
    res.status(201).json(loan);
  }),
);

libraryRouter.post(
  '/loans/:id/return',
  requirePermission('library:manage'),
  validate(z.object({ returnedAt: z.coerce.date().optional(), lost: z.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const { returnedAt, lost } = req.body as { returnedAt?: Date; lost: boolean };

    const result = await prisma.$transaction(async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id, schoolId } });
      if (!loan) throw notFound('Loan');
      if (loan.status === LoanStatus.RETURNED) throw conflict('This loan is already closed');

      const when = returnedAt ?? new Date();
      const late = daysLate(loan.dueDate, when);
      const fine = lost ? money(0) : round(money(late * FINE_PER_DAY));

      // A lost copy leaves circulation; a returned one comes back on the shelf.
      if (!lost) {
        await tx.book.update({ where: { id: loan.bookId }, data: { availableCopies: { increment: 1 } } });
      } else {
        await tx.book.update({ where: { id: loan.bookId }, data: { totalCopies: { decrement: 1 } } });
      }

      return tx.bookLoan.update({
        where: { id },
        data: {
          status: lost ? LoanStatus.LOST : LoanStatus.RETURNED,
          returnedAt: when,
          fineAmount: fine,
        },
        include: { book: { select: { title: true } } },
      });
    });

    await audit(req, {
      action: lost ? 'library.lost' : 'library.return',
      entityType: 'BookLoan',
      entityId: id,
    });
    res.json(result);
  }),
);

/** Overdue loans, refreshing their status as a side effect. */
libraryRouter.get(
  '/overdue',
  requirePermission('library:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const now = new Date();

    await prisma.bookLoan.updateMany({
      where: { schoolId, status: LoanStatus.BORROWED, dueDate: { lt: now } },
      data: { status: LoanStatus.OVERDUE },
    });

    const data = await prisma.bookLoan.findMany({
      where: { schoolId, status: LoanStatus.OVERDUE },
      orderBy: { dueDate: 'asc' },
      include: {
        book: { select: { title: true } },
        student: { select: { admissionNumber: true, firstName: true, lastName: true } },
      },
    });

    res.json({
      data: data.map((loan) => ({
        ...loan,
        daysOverdue: daysLate(loan.dueDate, now),
        accruedFine: round(money(daysLate(loan.dueDate, now) * FINE_PER_DAY)).toString(),
      })),
    });
  }),
);
