import { PrismaClient, type Prisma } from '@prisma/client';

type PrismaGlobal = typeof globalThis & {
  __prisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

// The spellings the configuration schema accepts as "on" for `LOG_SQL`.
const TRUTHY = new Set(['true', '1', 'yes', 'on', 'y', 'enabled']);

/**
 * What the client logs. Statements are logged with their parameters, which
 * carry personal data and password hashes, so they are opt-in (`LOG_SQL`) and
 * never logged in production, whatever the flag says.
 */
export const prismaLogLevels = (env: NodeJS.ProcessEnv): Prisma.LogLevel[] => {
  if (env.APP_ENV === 'production') return ['warn', 'error'];
  const levels: Prisma.LogLevel[] =
    env.APP_ENV === 'development' ? ['info', 'warn', 'error'] : ['warn', 'error'];
  return TRUTHY.has(env.LOG_SQL?.trim().toLowerCase() ?? '') ? ['query', ...levels] : levels;
};

export const prisma =
  prismaGlobal.__prisma ?? new PrismaClient({ log: prismaLogLevels(process.env) });

if (process.env.APP_ENV !== 'production') {
  prismaGlobal.__prisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export type PrismaDatabase = PrismaClient;
export type PrismaTransaction = Prisma.TransactionClient;

export { Prisma, PrismaClient } from '@prisma/client';
