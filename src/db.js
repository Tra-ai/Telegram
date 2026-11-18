import { PrismaClient } from '@prisma/client';
// Reuse one client across warm serverless invocations
export const prisma = (globalThis.__prisma ??= new PrismaClient());
