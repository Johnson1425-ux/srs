import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { money, round } from '../../lib/money.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nextOrderNumber } from '../../lib/sequence.js';

/** Module 13 — Inventory: assets, stationery, lab equipment, furniture. */
export const inventoryRouter: Router = Router();

const CATEGORIES = ['ASSET', 'STATIONERY', 'LAB_EQUIPMENT', 'FURNITURE', 'OTHER'] as const;

inventoryRouter.get(
  '/items',
  requirePermission('inventory:read'),
  validate(
    paginationSchema.extend({
      search: z.string().trim().optional(),
      category: z.enum(CATEGORIES).optional(),
      lowStock: z.coerce.boolean().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      search?: string;
      category?: string;
      lowStock?: boolean;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.category ? { category: q.category } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { name: 'asc' },
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    // Prisma cannot compare two columns in a filter, so low stock is applied here.
    const data = q.lowStock ? rows.filter((r) => r.quantity <= r.reorderLevel) : rows;

    res.json(paginate(data, q.lowStock ? data.length : total, q.page, q.pageSize));
  }),
);

const itemSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.enum(CATEGORIES),
  sku: z.string().max(40).nullish(),
  unit: z.string().max(20).default('piece'),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(0),
  unitCost: z.number().nonnegative().nullish(),
  location: z.string().max(80).nullish(),
});

inventoryRouter.post(
  '/items',
  requirePermission('inventory:manage'),
  validate(itemSchema),
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    await audit(req, { action: 'inventory.item_create', entityType: 'InventoryItem', entityId: item.id });
    res.status(201).json(item);
  }),
);

/** Stock in / out with an auditable movement trail. */
inventoryRouter.post(
  '/items/:id/movements',
  requirePermission('inventory:manage'),
  validate(
    z.object({
      direction: z.enum(['IN', 'OUT']),
      quantity: z.number().int().positive(),
      reason: z.string().max(200).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const { direction, quantity, reason } = req.body as {
      direction: 'IN' | 'OUT';
      quantity: number;
      reason?: string | null;
    };

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({ where: { id, schoolId } });
      if (!item) throw notFound('Inventory item');
      if (direction === 'OUT' && item.quantity < quantity) {
        throw badRequest(`Only ${item.quantity} ${item.unit}(s) in stock`);
      }

      const updated = await tx.inventoryItem.update({
        where: { id },
        data: {
          quantity: direction === 'IN' ? { increment: quantity } : { decrement: quantity },
        },
      });

      await tx.stockMovement.create({
        data: {
          itemId: id,
          direction,
          quantity,
          reason: reason ?? null,
          recordedById: req.user?.id ?? null,
        },
      });

      return updated;
    });

    await audit(req, {
      action: `inventory.stock_${direction.toLowerCase()}`,
      entityType: 'InventoryItem',
      entityId: id,
      metadata: { quantity },
    });
    res.json(result);
  }),
);

// --- Suppliers and purchase orders -----------------------------------------

inventoryRouter.get(
  '/suppliers',
  requirePermission('inventory:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.supplier.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
    });
    res.json({ data });
  }),
);

inventoryRouter.post(
  '/suppliers',
  requirePermission('inventory:manage'),
  validate(
    z.object({
      name: z.string().min(2).max(120),
      phone: z.string().max(30).nullish(),
      email: z.string().email().nullish(),
      address: z.string().max(200).nullish(),
      tin: z.string().max(30).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplier.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    res.status(201).json(supplier);
  }),
);

inventoryRouter.get(
  '/purchase-orders',
  requirePermission('inventory:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.purchaseOrder.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { orderDate: 'desc' },
      include: { supplier: { select: { name: true } }, lines: true },
    });
    res.json({ data });
  }),
);

inventoryRouter.post(
  '/purchase-orders',
  requirePermission('inventory:manage'),
  validate(
    z.object({
      supplierId: z.string().nullish(),
      lines: z
        .array(
          z.object({
            itemId: z.string().nullish(),
            description: z.string().min(2).max(200),
            quantity: z.number().int().positive(),
            unitPrice: z.number().nonnegative(),
          }),
        )
        .min(1),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { supplierId, lines } = req.body as {
      supplierId?: string | null;
      lines: Array<{ itemId?: string | null; description: string; quantity: number; unitPrice: number }>;
    };

    const total = round(
      lines.reduce<Prisma.Decimal>((acc, l) => acc.plus(money(l.unitPrice).times(l.quantity)), money(0)),
    );

    const order = await prisma.$transaction(async (tx) => {
      const orderNumber = await nextOrderNumber(schoolId, tx);
      return tx.purchaseOrder.create({
        data: {
          schoolId,
          supplierId: supplierId ?? null,
          orderNumber,
          total,
          lines: { create: lines },
        },
        include: { lines: true, supplier: true },
      });
    });

    await audit(req, { action: 'purchase_order.create', entityType: 'PurchaseOrder', entityId: order.id });
    res.status(201).json(order);
  }),
);

/** Receiving an order moves its lines into stock and books the expense. */
inventoryRouter.post(
  '/purchase-orders/:id/receive',
  requirePermission('inventory:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const order = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id, schoolId },
        include: { lines: true },
      });
      if (!po) throw notFound('Purchase order');
      if (po.status === 'RECEIVED') throw badRequest('This order has already been received');

      for (const line of po.lines) {
        if (!line.itemId) continue;
        await tx.inventoryItem.update({
          where: { id: line.itemId },
          data: { quantity: { increment: line.quantity }, unitCost: line.unitPrice },
        });
        await tx.stockMovement.create({
          data: {
            itemId: line.itemId,
            direction: 'IN',
            quantity: line.quantity,
            reason: `Purchase order ${po.orderNumber}`,
            recordedById: req.user?.id ?? null,
          },
        });
      }

      await tx.ledgerEntry.create({
        data: {
          schoolId,
          entryType: 'EXPENSE',
          category: 'Supplies',
          description: `Purchase order ${po.orderNumber}`,
          amount: po.total,
          entryDate: new Date(),
          reference: po.orderNumber,
          recordedById: req.user?.id ?? null,
        },
      });

      return tx.purchaseOrder.update({ where: { id }, data: { status: 'RECEIVED' } });
    });

    await audit(req, { action: 'purchase_order.receive', entityType: 'PurchaseOrder', entityId: id });
    res.json(order);
  }),
);
