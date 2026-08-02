import { Router } from 'express';
import { Gender } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/** Module 15 — Hostel (optional): rooms, beds, occupancy and boarders. */
export const hostelRouter: Router = Router();

hostelRouter.get(
  '/',
  requirePermission('hostel:read'),
  asyncHandler(async (req, res) => {
    const hostels = await prisma.hostel.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
      include: {
        rooms: {
          orderBy: { roomNumber: 'asc' },
          include: {
            _count: { select: { allocations: { where: { releasedAt: null } } } },
          },
        },
      },
    });

    res.json({
      data: hostels.map((h) => {
        const beds = h.rooms.reduce((acc, r) => acc + r.bedCount, 0);
        const occupied = h.rooms.reduce((acc, r) => acc + r._count.allocations, 0);
        return {
          ...h,
          occupancy: { beds, occupied, free: beds - occupied },
        };
      }),
    });
  }),
);

hostelRouter.post(
  '/',
  requirePermission('hostel:manage'),
  validate(
    z.object({
      name: z.string().min(2).max(80),
      gender: z.nativeEnum(Gender),
      wardenId: z.string().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const hostel = await prisma.hostel.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    res.status(201).json(hostel);
  }),
);

hostelRouter.post(
  '/:id/rooms',
  requirePermission('hostel:manage'),
  validate(
    z.object({
      roomNumber: z.string().min(1).max(20),
      bedCount: z.number().int().min(1).max(20).default(4),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const hostelId = req.params.id as string;
    const hostel = await prisma.hostel.findFirst({ where: { id: hostelId, schoolId } });
    if (!hostel) throw notFound('Hostel');

    const room = await prisma.hostelRoom.create({ data: { ...req.body, hostelId } });
    res.status(201).json(room);
  }),
);

hostelRouter.post(
  '/rooms/:roomId/allocate',
  requirePermission('hostel:manage'),
  validate(
    z.object({ studentId: z.string().min(1), bedNumber: z.number().int().min(1).nullish() }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const roomId = req.params.roomId as string;
    const { studentId, bedNumber } = req.body as { studentId: string; bedNumber?: number | null };

    const allocation = await prisma.$transaction(async (tx) => {
      const room = await tx.hostelRoom.findFirst({
        where: { id: roomId, hostel: { schoolId } },
        include: {
          hostel: { select: { gender: true, name: true } },
          allocations: { where: { releasedAt: null } },
        },
      });
      if (!room) throw notFound('Room');

      const student = await tx.student.findFirst({ where: { id: studentId, schoolId } });
      if (!student) throw notFound('Student');

      // A boys' hostel takes boys, a girls' hostel takes girls.
      if (student.gender !== room.hostel.gender) {
        throw badRequest(`${room.hostel.name} accommodates ${room.hostel.gender.toLowerCase()} students only`);
      }
      if (room.allocations.length >= room.bedCount) {
        throw conflict(`Room ${room.roomNumber} is full (${room.bedCount} beds)`);
      }
      if (bedNumber && room.allocations.some((a) => a.bedNumber === bedNumber)) {
        throw conflict(`Bed ${bedNumber} is already taken`);
      }

      const active = await tx.hostelAllocation.findFirst({
        where: { studentId, releasedAt: null },
      });
      if (active) throw conflict('This student already has a bed allocated');

      return tx.hostelAllocation.create({
        data: { roomId, studentId, bedNumber: bedNumber ?? null },
        include: {
          student: { select: { admissionNumber: true, firstName: true, lastName: true } },
        },
      });
    });

    await audit(req, { action: 'hostel.allocate', entityType: 'HostelAllocation', entityId: allocation.id });
    res.status(201).json(allocation);
  }),
);

hostelRouter.post(
  '/allocations/:id/release',
  requirePermission('hostel:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const allocation = await prisma.hostelAllocation.findFirst({
      where: { id, room: { hostel: { schoolId } } },
    });
    if (!allocation) throw notFound('Allocation');
    if (allocation.releasedAt) throw conflict('This allocation is already released');

    const updated = await prisma.hostelAllocation.update({
      where: { id },
      data: { releasedAt: new Date() },
    });
    res.json(updated);
  }),
);
