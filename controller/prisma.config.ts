import { defineConfig } from "prisma/config";

// O comando local injeta apenas a URL de migrations. Não usa DATABASE_URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
});
