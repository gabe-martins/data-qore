import type { Prisma } from "../generated/prisma/client.js";

// Shared by schedule changes and deletion; references live in the app database.
export async function lockComparisons(tx: Prisma.TransactionClient, ids: string[]) {
  for (const id of [...new Set(ids.map(value => value.toLowerCase()))].sort()) {
    const key = "dataqore:comparison:" + id;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  }
}
