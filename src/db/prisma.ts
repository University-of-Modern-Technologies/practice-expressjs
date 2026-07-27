import { PrismaClient, type Prisma } from '@prisma/client';

type PrismaGlobal = typeof globalThis & {
  __prisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

export const prisma =
  prismaGlobal.__prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  prismaGlobal.__prisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export type PrismaDatabase = PrismaClient;
export type PrismaTransaction = Prisma.TransactionClient;

export { Prisma, PrismaClient } from '@prisma/client';
