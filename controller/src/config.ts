import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
let location = dirname(fileURLToPath(import.meta.url));
while (
  !existsSync(resolve(location, "engine.env.example")) &&
  dirname(location) !== location
)
  location = dirname(location);
export const root = location;
export interface Config {
  databaseUrl: string;
  engineUrl: string;
  engineKey: string;
  jwtSecret: string;
  webOrigin: string;
  accessSeconds: number;
  refreshSeconds: number;
}
export function loadConfig(): Config {
  const path = process.env.DATAQORE_ENV_FILE || resolve(root, "controller.env");
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(path));
  } catch {
    /* Environment-only configuration is supported. */
  }
  const get = (k: string, d = "") => process.env[k] ?? file[k] ?? d;
  const databaseUrl = get("DATABASE_URL");
  try {
    const u = new URL(databaseUrl);
    if (
      u.protocol !== "postgresql:" ||
      decodeURIComponent(u.username) !== "srv_dataqore_app" ||
      u.pathname !== "/dataqore_app"
    )
      throw Error();
  } catch {
    throw Error("DATABASE_URL must use srv_dataqore_app in dataqore_app.");
  }
  const engineUrl = get("ENGINE_API_URL", "http://127.0.0.1:8000");
  const webOrigin = get("WEB_ORIGIN", "http://127.0.0.1:5173");
  for (const value of [engineUrl, webOrigin]) {
    try {
      const u = new URL(value);
      if (
        u.origin !== value ||
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password
      )
        throw Error();
    } catch {
      throw Error("Configure valid ENGINE_API_URL and WEB_ORIGIN origins.");
    }
  }
  const engineKey = get("ENGINE_API_KEY");
  const jwtSecret = get("JWT_SECRET");
  if (engineKey.length < 16 || engineKey.startsWith("SUBSTITUIR"))
    throw Error("Configure ENGINE_API_KEY.");
  if (jwtSecret.length < 32 || jwtSecret.startsWith("SUBSTITUIR"))
    throw Error("Configure JWT_SECRET with at least 32 random characters.");
  const positive = z.coerce.number().int().positive();
  return {
    databaseUrl,
    engineUrl,
    engineKey,
    jwtSecret,
    webOrigin,
    accessSeconds: positive.parse(get("ACCESS_TOKEN_SECONDS", "900")),
    refreshSeconds: positive.parse(get("REFRESH_TOKEN_SECONDS", "604800")),
  };
}
