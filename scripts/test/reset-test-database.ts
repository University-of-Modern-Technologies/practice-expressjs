import { createTestPrismaClient, resetDatabase } from '../../src/test/db/index.js';

async function main(): Promise<void> {
  const prisma = createTestPrismaClient();

  try {
    await resetDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Test database reset failed.', error);
  process.exitCode = 1;
});
