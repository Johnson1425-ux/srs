import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ['error', 'warn'] : ['error'],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export { env };
