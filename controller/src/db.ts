import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
export function database(url: string) {
  const u = new URL(url);
  u.searchParams.delete("schema");
  return new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: u.toString(),
        connectionTimeoutMillis: 10000,
        max: 5,
      },
      { schema: "app" },
    ),
    log: [],
  });
}
export type DB = ReturnType<typeof database>;
