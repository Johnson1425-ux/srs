import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';

/** Module 14 — Transport: buses, routes, drivers, fuel and maintenance. */
export const transportRouter: Router = Router();

// --- Vehicles ---------------------------------------------------------------

transportRouter.get(
  '/vehicles',
  requirePermission('transport:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.vehicle.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { plateNumber: 'asc' },
      include: {
        driver: { select: { id: true, firstName: true, lastName: true, phone: true } },
        routes: { select: { id: true, name: true } },
      },
    });
    res.json({ data });
  }),
);

transportRouter.post(
  '/vehicles',
  requirePermission('transport:manage'),
  validate(
    z.object({
      plateNumber: z.string().min(3).max(20),
      model: z.string().max(80).nullish(),
      capacity: z.number().int().min(1).max(100).default(30),
      driverId: z.string().nullish(),
      insuranceExpiry: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const vehicle = await prisma.vehicle.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    await audit(req, { action: 'vehicle.create', entityType: 'Vehicle', entityId: vehicle.id });
    res.status(201).json(vehicle);
  }),
);

// --- Routes and allocation --------------------------------------------------

transportRouter.get(
  '/routes',
  requirePermission('transport:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.transportRoute.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
      include: {
        vehicle: { select: { id: true, plateNumber: true, capacity: true } },
        _count: { select: { allocations: { where: { isActive: true } } } },
      },
    });
    res.json({ data });
  }),
);

transportRouter.post(
  '/routes',
  requirePermission('transport:manage'),
  validate(
    z.object({
      name: z.string().min(2).max(80),
      vehicleId: z.string().nullish(),
      fare: z.number().nonnegative().default(0),
      stops: z
        .array(z.object({ name: z.string().min(1), pickupTime: z.string().optional() }))
        .optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const route = await prisma.transportRoute.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    res.status(201).json(route);
  }),
);

transportRouter.post(
  '/routes/:id/allocations',
  requirePermission('transport:manage'),
  validate(
    z.object({ studentId: z.string().min(1), pickupStop: z.string().max(80).nullish() }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const routeId = req.params.id as string;

    const route = await prisma.transportRoute.findFirst({
      where: { id: routeId, schoolId },
      include: {
        vehicle: { select: { capacity: true } },
        _count: { select: { allocations: { where: { isActive: true } } } },
      },
    });
    if (!route) throw notFound('Route');

    const student = await prisma.student.findFirst({
      where: { id: req.body.studentId, schoolId },
    });
    if (!student) throw notFound('Student');

    // Don't allocate more students than the assigned bus can carry.
    if (route.vehicle && route._count.allocations >= route.vehicle.capacity) {
      throw conflict(`Route is at capacity (${route.vehicle.capacity} seats)`);
    }

    const allocation = await prisma.transportAllocation.upsert({
      where: { routeId_studentId: { routeId, studentId: req.body.studentId } },
      create: { routeId, studentId: req.body.studentId, pickupStop: req.body.pickupStop ?? null },
      update: { pickupStop: req.body.pickupStop ?? null, isActive: true },
      include: {
        student: { select: { admissionNumber: true, firstName: true, lastName: true } },
      },
    });

    await audit(req, { action: 'transport.allocate', entityType: 'TransportAllocation', entityId: allocation.id });
    res.status(201).json(allocation);
  }),
);

transportRouter.get(
  '/routes/:id/manifest',
  requirePermission('transport:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const route = await prisma.transportRoute.findFirst({
      where: { id: req.params.id as string, schoolId },
      include: {
        vehicle: { include: { driver: { select: { firstName: true, lastName: true, phone: true } } } },
        allocations: {
          where: { isActive: true },
          include: {
            student: {
              select: {
                id: true,
                admissionNumber: true,
                firstName: true,
                lastName: true,
                enrollments: {
                  where: { isActive: true },
                  select: { schoolClass: { select: { name: true } } },
                },
                guardianLinks: {
                  where: { isPrimary: true },
                  include: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!route) throw notFound('Route');
    res.json(route);
  }),
);

// --- Fuel and maintenance ---------------------------------------------------

transportRouter.post(
  '/vehicles/:id/fuel',
  requirePermission('transport:manage'),
  validate(
    z.object({
      litres: z.number().positive(),
      cost: z.number().nonnegative(),
      odometer: z.number().int().nonnegative().nullish(),
      filledAt: z.coerce.date().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const vehicleId = req.params.id as string;
    const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, schoolId } });
    if (!vehicle) throw notFound('Vehicle');

    const [log] = await prisma.$transaction([
      prisma.fuelLog.create({ data: { ...req.body, vehicleId } }),
      prisma.ledgerEntry.create({
        data: {
          schoolId,
          entryType: 'EXPENSE',
          category: 'Transport',
          description: `Fuel — ${vehicle.plateNumber}`,
          amount: req.body.cost,
          entryDate: req.body.filledAt ?? new Date(),
          recordedById: req.user?.id ?? null,
        },
      }),
    ]);

    res.status(201).json(log);
  }),
);

transportRouter.post(
  '/vehicles/:id/maintenance',
  requirePermission('transport:manage'),
  validate(
    z.object({
      description: z.string().min(2).max(300),
      cost: z.number().nonnegative(),
      servicedAt: z.coerce.date().optional(),
      garage: z.string().max(120).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const vehicleId = req.params.id as string;
    const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, schoolId } });
    if (!vehicle) throw notFound('Vehicle');

    const [log] = await prisma.$transaction([
      prisma.maintenanceLog.create({ data: { ...req.body, vehicleId } }),
      prisma.ledgerEntry.create({
        data: {
          schoolId,
          entryType: 'EXPENSE',
          category: 'Transport',
          description: `Maintenance — ${vehicle.plateNumber}: ${req.body.description}`,
          amount: req.body.cost,
          entryDate: req.body.servicedAt ?? new Date(),
          recordedById: req.user?.id ?? null,
        },
      }),
    ]);

    res.status(201).json(log);
  }),
);
